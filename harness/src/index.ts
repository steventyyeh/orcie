import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// Per-agent harness: delivers messages to the in-container tmux pane (by file pointer, never large pastes).
const tmux = (...a: string[]) => execFileSync("tmux", a, { encoding: "utf8" });
const body = async (req: AsyncIterable<Buffer>) => { let r = ""; for await (const c of req) r += c; return r ? JSON.parse(r) : {}; };

createServer(async (req, res) => {
  const json = (code: number, b: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  try {
    if (req.url === "/healthz") return json(200, { ok: true, tmux: tmux("has-session", "-t", "agent") === "" });
    if (req.url === "/screen") return json(200, { screen: tmux("capture-pane", "-t", "agent", "-p") });
    if (req.method === "POST" && req.url === "/send") {
      const { from = "user", text } = await body(req);
      const id = `${Date.now()}-${from}.md`;
      writeFileSync(`/data/inbox/${id}`, `From: ${from}\n\n${text}\n`);
      tmux("send-keys", "-t", "agent", "-l", `New message from ${from}: read /data/inbox/${id} and respond. (To DM an agent: orcie-dm <name> "text")`);
      tmux("send-keys", "-t", "agent", "Enter");
      return json(200, { delivered: id });
    }
    json(404, { error: "not found" });
  } catch (e) { json(500, { error: String(e) }); }
}).listen(9090, () => console.log("orcie harness up"));
