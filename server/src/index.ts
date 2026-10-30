import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Control plane (POC): agents are Docker containers; state is a JSON file. See docs/DESIGN.md.
type Agent = { name: string; model: string; container: string; port: number; created: string };
const STORE = process.env.ORCIE_STORE ?? "agents.json";
const IMAGE = "orcie-agent:dev";
const agents: Record<string, Agent> = existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : {};
const save = () => writeFileSync(STORE, JSON.stringify(agents, null, 2));
const docker = (...a: string[]) => execFileSync("docker", a, { encoding: "utf8", env: process.env }).trim();
const hostPort = (c: string) => Number(docker("port", c, "9090/tcp").split("\n")[0].split(":").pop());
const call = async (a: Agent, path: string, init?: RequestInit) =>
  (await fetch(`http://127.0.0.1:${a.port}${path}`, init)).json();

function create(name: string, model: string) {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("CLAUDE_CODE_OAUTH_TOKEN not set (subscription token; see README)");
  if (agents[name]) throw new Error(`agent ${name} exists`);
  const container = `orcie-${name}`;
  // Token is passed by inheriting the env var (never on the command line). No API key is ever set.
  docker("run", "-d", "--name", container, "--restart", "unless-stopped", "--cpus", "2", "--memory", "4g",
    "-v", `orcie-${name}-data:/data`, "-p", "127.0.0.1:0:9090",
    "--add-host", "host.docker.internal:host-gateway",
    "-e", "CLAUDE_CODE_OAUTH_TOKEN", "-e", `AGENT_NAME=${name}`, "-e", `ORCIE_MODEL=${model}`, IMAGE);
  agents[name] = { name, model, container, port: hostPort(container), created: new Date().toISOString() };
  save();
  return agents[name];
}

createServer(async (req, res) => {
  const json = (code: number, b: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  try {
    let raw = ""; for await (const c of req) raw += c;
    const b = raw ? JSON.parse(raw) : {};
    const url = req.url ?? "";
    let m: RegExpMatchArray | null;
    if (url === "/healthz") return json(200, { ok: true });
    if (req.method === "GET" && url === "/agents") return json(200, Object.values(agents));
    if (req.method === "POST" && url === "/agents") return json(201, create(b.name, b.model ?? "claude-sonnet-5-5"));
    if (req.method === "POST" && url === "/dm") { // agent->agent (or user->agent) direct message
      const to = agents[b.to]; if (!to) return json(404, { error: `no agent ${b.to}` });
      return json(200, await call(to, "/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: b.from, text: b.text }) }));
    }
    if ((m = url.match(/^\/agents\/([^/]+)\/screen$/)) && agents[m[1]]) return json(200, await call(agents[m[1]], "/screen"));
    if ((m = url.match(/^\/agents\/([^/]+)\/health$/)) && agents[m[1]]) return json(200, await call(agents[m[1]], "/healthz"));
    if (req.method === "DELETE" && (m = url.match(/^\/agents\/([^/]+)$/)) && agents[m[1]]) {
      docker("rm", "-f", agents[m[1]].container); delete agents[m[1]]; save(); return json(200, { deleted: m[1] });
    }
    json(404, { error: "not found" });
  } catch (e) { json(500, { error: String(e) }); }
}).listen(Number(process.env.PORT ?? 8080), () => console.log("orcie server up"));
