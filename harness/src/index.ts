import { createServer } from "node:http";

// Per-agent harness stub. Will drive the Claude CLI per session (DESIGN.md §7).
createServer(async (req, res) => {
  if (req.url === "/healthz") return void res.end("ok");
  const m = req.url?.match(/^\/sessions\/([^/]+)\/messages$/);
  if (req.method === "POST" && m) {
    let raw = "";
    for await (const c of req) raw += c;
    // TODO: spawn `claude -p --output-format stream-json --resume <session>`.
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ session: m[1], reply: `echo: ${raw}` }));
  }
  res.writeHead(404).end();
}).listen(Number(process.env.PORT ?? 9090), () => console.log("orcie harness up"));
