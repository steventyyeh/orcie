import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

// Per-agent harness: runs the Claude CLI headless, one turn per message, one resumable session per conversation.
const MODEL = process.env.ORCIE_MODEL ?? "claude-sonnet-5-5";
const SESSIONS = "/data/sessions.json"; // conversation id -> claude session id
const LOG = "/data/logs/turns.jsonl";
const sessions: Record<string, string> = existsSync(SESSIONS) ? JSON.parse(readFileSync(SESSIONS, "utf8")) : {};
const queues = new Map<string, Promise<unknown>>(); // serial execution per conversation

function runClaude(conversation: string, prompt: string): Promise<{ reply: string; session: string }> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--model", MODEL];
    if (sessions[conversation]) args.push("--resume", sessions[conversation]);
    const p = spawn("claude", args, { cwd: "/data/workspace" });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      try {
        const j = JSON.parse(out);
        sessions[conversation] = j.session_id;
        writeFileSync(SESSIONS, JSON.stringify(sessions, null, 2));
        resolve({ reply: j.result ?? "", session: j.session_id });
      } catch { reject(new Error(`claude exited ${code}: ${err || out}`.slice(0, 2000))); }
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
      const { from = "user", text, conversation = `dm:${from}` } = await body(req);
      const prev = queues.get(conversation) ?? Promise.resolve();
      const turn = prev.catch(() => {}).then(() => runClaude(conversation, `[message from ${from}]\n${text}`));
      queues.set(conversation, turn);
      const r = await turn;
      appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), conversation, from, text, reply: r.reply }) + "\n");
      return json(200, { conversation, ...r });
    }
    json(404, { error: "not found" });
  } catch (e) { json(500, { error: String(e) }); }
}).listen(9090, () => console.log("orcie harness up"));
