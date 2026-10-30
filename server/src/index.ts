import { createServer } from "node:http";

// Control-plane stub. See docs/DESIGN.md §2-3 for the planned components.
type Agent = { id: string; name: string; model: string; status: string };
const agents = new Map<string, Agent>();

createServer(async (req, res) => {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/healthz") return json(200, { ok: true });
  if (req.method === "GET" && req.url === "/agents") return json(200, [...agents.values()]);
  if (req.method === "POST" && req.url === "/agents") {
    let raw = "";
    for await (const c of req) raw += c;
    const { name, model } = JSON.parse(raw || "{}");
    // TODO: container manager starts the agent's harness container here.
    const agent: Agent = { id: crypto.randomUUID(), name, model, status: "creating" };
    agents.set(agent.id, agent);
    return json(201, agent);
  }
  json(404, { error: "not found" });
}).listen(Number(process.env.PORT ?? 8080), () => console.log("orcie server up"));
