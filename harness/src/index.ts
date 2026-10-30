import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

// Per-agent harness: runs the Claude CLI headless, one turn per message, one resumable session per conversation.
const MODEL = process.env.ORCIE_MODEL ?? "claude-sonnet-5-5";
const SESSIONS = "/data/sessions.json"; // conversation id -> claude session id
const LOG = "/data/logs/turns.jsonl";
const sessions: Record<string, string> = existsSync(SESSIONS) ? JSON.parse(readFileSync(SESSIONS, "utf8")) : {};
const queues = new Map<string, Promise<unknown>>(); // serial execution per conversation

type Ev = { kind: "tool"; id: string; name: string; input: unknown } | { kind: "tool_result"; id: string; ok: boolean; preview: string } | { kind: "text"; text: string };

// Runs one turn with stream-json so tool use can be reported live; resolves with the final reply.
function runClaude(conversation: string, prompt: string, onEvent: (e: Ev) => void): Promise<{ reply: string; session: string }> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--model", MODEL];
    if (sessions[conversation]) args.push("--resume", sessions[conversation]);
    const p = spawn("claude", args, { cwd: "/data/workspace" });
    let buf = "", err = "", final: { result?: string; session_id?: string; is_error?: boolean } | null = null;
    const line = (l: string) => {
      let j: any; try { j = JSON.parse(l); } catch { return; }
      if (j.type === "assistant") for (const c of j.message?.content ?? []) {
        if (c.type === "tool_use") onEvent({ kind: "tool", id: c.id, name: c.name, input: c.input });
        else if (c.type === "text" && c.text?.trim()) onEvent({ kind: "text", text: c.text });
      } else if (j.type === "user") for (const c of j.message?.content ?? []) {
        if (c.type === "tool_result") {
          const t = typeof c.content === "string" ? c.content : (c.content ?? []).map((x: any) => x.text ?? "").join("\n");
          onEvent({ kind: "tool_result", id: c.tool_use_id, ok: !c.is_error, preview: t.slice(0, 400) });
        }
      } else if (j.type === "result") final = j;
    };
    p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (buf.trim()) line(buf);
      if (!final?.session_id) return reject(new Error(`claude exited ${code}: ${err}`.slice(0, 2000)));
      sessions[conversation] = final.session_id;
      writeFileSync(SESSIONS, JSON.stringify(sessions, null, 2));
      resolve({ reply: final.result ?? "", session: final.session_id });
    });
    p.stdin.end(prompt); // via stdin: no size limit, no truncation
  });
}

const body = async (req: AsyncIterable<Buffer>) => { let r = ""; for await (const c of req) r += c; return r ? JSON.parse(r) : {}; };

createServer(async (req, res) => {
  const json = (code: number, b: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  try {
    if (req.url === "/healthz") return json(200, { ok: true, conversations: Object.keys(sessions) });
    if (req.url === "/log") return json(200, { log: existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").slice(-20).map((l) => JSON.parse(l)) : [] });
    if (req.method === "POST" && req.url === "/send") {
      // Streams NDJSON: tool events as they happen, then a final {kind:"done"} (or {kind:"error"}).
      const { from = "user", text, conversation = `dm:${from}` } = await body(req);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const out = (o: unknown) => res.write(JSON.stringify(o) + "\n");
      const prev = queues.get(conversation) ?? Promise.resolve();
      const turn = prev.catch(() => {}).then(() => runClaude(conversation, `[message from ${from}]\n${text}`, out));
      queues.set(conversation, turn);
      try {
        const r = await turn;
        appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), conversation, from, text, reply: r.reply }) + "\n");
        out({ kind: "done", conversation, ...r });
      } catch (e) { out({ kind: "error", error: String(e) }); }
      return void res.end();
    }
    json(404, { error: "not found" });
  } catch (e) { json(500, { error: String(e) }); }
}).listen(9090, () => console.log("orcie harness up"));
