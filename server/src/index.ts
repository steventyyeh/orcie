import { createServer, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Control plane (POC): agents are Docker containers; conversations/rooms are persisted in a JSON file.
// Router rule (docs/DESIGN.md §6): a conversation's messages reach every agent member's session for that conversation.
type Agent = { name: string; model: string; container: string; port: number; created: string };
type Item = { id: string; name: string; input: string; result?: string; ok?: boolean };
type Msg = { seq: number; from: string; text: string; at: string; activity?: Item[] };
type Conv = { id: string; kind: "dm" | "room"; title: string; members: string[]; messages: Msg[]; cursor: Record<string, number>; mode?: "parallel" | "sequential" };

const STORE = process.env.ORCIE_STORE ?? "agents.json";
const STATE = process.env.ORCIE_STATE ?? "state.json";
const CREDS = process.env.ORCIE_CREDS ?? `${process.env.HOME}/.orcie/creds`;
const IMAGE = "orcie-agent:dev";
const WEB = new URL("../../web/index.html", import.meta.url);

const agents: Record<string, Agent> = existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : {};
const convs: Record<string, Conv> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const saveAgents = () => writeFileSync(STORE, JSON.stringify(agents, null, 2));
const saveConvs = () => writeFileSync(STATE, JSON.stringify(convs, null, 2));

const docker = (...a: string[]) => execFileSync("docker", a, { encoding: "utf8", env: process.env }).trim();
const hostPort = (c: string) => Number(docker("port", c, "9090/tcp").split("\n")[0].split(":").pop()); // port changes on restart
// Streams one turn from the agent's harness (NDJSON), reporting tool use via onEvent; resolves with the reply.
async function turn(a: Agent, body: unknown, onEvent: (e: any) => void): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${hostPort(a.container)}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(900_000) });
  const dec = new TextDecoder(); let buf = "", reply: string | null = null;
  const line = (l: string) => { if (!l.trim()) return; const e = JSON.parse(l); if (e.kind === "done") reply = e.reply; else if (e.kind === "error") throw new Error(e.error); else onEvent(e); };
  for await (const chunk of r.body as any) { buf += dec.decode(chunk, { stream: true }); let i; while ((i = buf.indexOf("\n")) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } }
  line(buf);
  if (reply === null) throw new Error("agent stream ended without a reply");
  return reply;
}
const summarize = (input: any) => { const v = input?.command ?? input?.file_path ?? input?.url ?? input?.pattern ?? input?.path ?? input?.prompt ?? JSON.stringify(input ?? {}); return String(v).slice(0, 300); };
const harness = async (a: Agent, path: string, init?: RequestInit) =>
  (await fetch(`http://127.0.0.1:${hostPort(a.container)}${path}`, { ...init, signal: AbortSignal.timeout(900_000) })).json();

// ---- live events (SSE) ----
const clients = new Set<ServerResponse>();
const emit = (e: unknown) => clients.forEach((c) => c.write(`data: ${JSON.stringify(e)}\n\n`));

// ---- agents (HR) ----
function createAgent(name: string, model: string) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name ?? "")) throw new Error("name must be lowercase letters/digits/dashes");
  if (!existsSync(`${CREDS}/.credentials.json`)) throw new Error(`no subscription login at ${CREDS}; run scripts/export-login.sh`);
  if (agents[name]) throw new Error(`agent ${name} exists`);
  const container = `orcie-${name}`;
  // Subscription login mounted from a private dir. No API key is ever set.
  docker("run", "-d", "--name", container, "--restart", "unless-stopped", "--cpus", "2", "--memory", "4g",
    "-v", `orcie-${name}-data:/data`, "-v", `${CREDS}:/creds`, "-p", "127.0.0.1:0:9090",
    "--add-host", "host.docker.internal:host-gateway",
    "-e", `AGENT_NAME=${name}`, "-e", `ORCIE_MODEL=${model}`, IMAGE);
  agents[name] = { name, model, container, port: hostPort(container), created: new Date().toISOString() };
  saveAgents();
  ensureConv(`dm:${name}`, "dm", name, [name]);
  emit({ type: "state" });
  return agents[name];
}

// ---- conversations ----
function ensureConv(id: string, kind: Conv["kind"], title: string, members: string[]) {
  return (convs[id] ??= { id, kind, title, members, messages: [], cursor: {} });
}
function post(c: Conv, from: string, text: string, activity?: Item[]) {
  const m: Msg = { seq: (c.messages.at(-1)?.seq ?? 0) + 1, from, text, at: new Date().toISOString(), ...(activity?.length ? { activity } : {}) };
  c.messages.push(m); saveConvs(); emit({ type: "message", conv: c.id, msg: m });
  return m;
}

// Deliver everything the agent hasn't seen in this conversation, run one turn, post the reply.
async function deliver(c: Conv, agent: string): Promise<string | null> {
  const unseen = c.messages.filter((m) => m.seq > (c.cursor[agent] ?? 0) && m.from !== agent);
  if (!unseen.length) return null;
  const upto = c.messages.at(-1)!.seq;
  const transcript = unseen.map((m) => `[${m.from}] ${m.text}`).join("\n");
  const text = c.kind === "room"
    ? `You are in the chat room "${c.title}" (members: user, ${c.members.join(", ")}). Messages you haven't seen:\n${transcript}\n\nYour reply is posted to the whole room. If you have nothing useful to add, reply exactly NO_REPLY.`
    : transcript;
  emit({ type: "typing", conv: c.id, agent, on: true });
  const items: Item[] = [];
  try {
    const reply = (await turn(agents[agent], { from: c.kind === "room" ? `room:${c.title}` : unseen.at(-1)!.from, text, conversation: c.id }, (e) => {
      if (e.kind === "tool") { const item = { id: e.id, name: e.name, input: summarize(e.input) }; items.push(item); emit({ type: "activity", conv: c.id, agent, item }); }
      else if (e.kind === "tool_result") { const it = items.find((x) => x.id === e.id); if (it) { it.result = e.preview; it.ok = e.ok; emit({ type: "activity", conv: c.id, agent, update: { id: e.id, result: e.preview, ok: e.ok } }); } }
    })).trim();
    c.cursor[agent] = upto;
    if (reply && reply !== "NO_REPLY") post(c, agent, reply, items);
    return reply;
  } catch (e) {
    post(c, "system", `${agent} failed: ${String(e).slice(0, 300)}`);
    return null;
  } finally { emit({ type: "typing", conv: c.id, agent, on: false }); }
}

// Room fan-out: "parallel" (default) runs all addressed agents at once; "sequential" runs them in turn so each sees
// earlier replies. Rounds are serialized per conversation either way.
const chains = new Map<string, Promise<unknown>>();
function trigger(c: Conv, text: string) {
  const mentioned = c.members.filter((n) => new RegExp(`@${n}\\b`).test(text));
  const targets = c.kind === "dm" ? c.members : mentioned.length ? mentioned : c.members;
  const run = async () => {
    if (c.mode === "sequential") for (const a of targets) await deliver(c, a);
    else await Promise.all(targets.map((a) => deliver(c, a)));
  };
  chains.set(c.id, (chains.get(c.id) ?? Promise.resolve()).then(run, run));
}

// ---- HTTP ----
const view = (c: Conv) => ({ id: c.id, kind: c.kind, title: c.title, members: c.members, last: c.messages.at(-1) ?? null, count: c.messages.length, mode: c.mode ?? "parallel",
  inbound: c.messages.filter((m) => m.from !== "user" && m.from !== "system").map((m) => m.seq) }); // seqs of messages the user hasn't authored (for unread counts)

createServer(async (req, res) => {
  const json = (code: number, b: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  try {
    const url = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && (url === "/" || url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html" }); return void res.end(readFileSync(WEB));
    }
    if (url === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": ok\n\n"); clients.add(res); return void req.on("close", () => clients.delete(res));
    }
    let raw = ""; for await (const c of req) raw += c;
    const b = raw ? JSON.parse(raw) : {};
    let m: RegExpMatchArray | null;

    if (url === "/healthz") return json(200, { ok: true });
    if (req.method === "GET" && url === "/api/state") return json(200, { agents: Object.values(agents), conversations: Object.values(convs).map(view) });
    if ((m = url.match(/^\/api\/conversations\/([^/]+)$/)) && req.method === "GET") {
      const c = convs[decodeURIComponent(m[1])]; return c ? json(200, c) : json(404, { error: "no such conversation" });
    }
    if ((m = url.match(/^\/api\/conversations\/([^/]+)\/messages$/)) && req.method === "POST") {
      const c = convs[decodeURIComponent(m[1])]; if (!c) return json(404, { error: "no such conversation" });
      if (c.kind === "dm" && !c.members.includes("user") && c.id.includes("+")) return json(400, { error: "agent-to-agent DMs are read-only" });
      const msg = post(c, "user", String(b.text ?? "")); trigger(c, msg.text); return json(202, msg);
    }
    if (req.method === "POST" && url === "/api/rooms") {
      const members: string[] = (b.members ?? []).filter((n: string) => agents[n]);
      const title = String(b.title ?? "").trim(); if (!title) return json(400, { error: "title required" });
      const id = `room:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      if (convs[id]) return json(409, { error: "room exists" });
      const c = ensureConv(id, "room", title, members); c.mode = b.mode === "sequential" ? "sequential" : "parallel"; saveConvs(); emit({ type: "state" }); return json(201, view(c));
    }
    if ((m = url.match(/^\/api\/rooms\/([^/]+)\/mode$/)) && req.method === "POST") {
      const c = convs[decodeURIComponent(m[1])]; if (!c || c.kind !== "room") return json(404, { error: "not found" });
      c.mode = b.mode === "sequential" ? "sequential" : "parallel"; saveConvs(); emit({ type: "state" }); return json(200, view(c));
    }
    if ((m = url.match(/^\/api\/rooms\/([^/]+)\/members$/)) && req.method === "POST") {
      const c = convs[decodeURIComponent(m[1])]; if (!c || c.kind !== "room" || !agents[b.name]) return json(404, { error: "not found" });
      if (!c.members.includes(b.name)) c.members.push(b.name);
      post(c, "system", `${b.name} joined the room`); emit({ type: "state" }); return json(200, view(c));
    }

    // CLI + in-container tools (orcie-dm)
    if (req.method === "GET" && url === "/agents") return json(200, Object.values(agents));
    if (req.method === "POST" && url === "/agents") return json(201, createAgent(b.name, b.model ?? "claude-sonnet-5-5"));
    if (req.method === "POST" && url === "/dm") { // sync agent->agent (or user->agent) DM; returns the reply
      if (!agents[b.to]) return json(404, { error: `no agent ${b.to}` });
      const from = b.from ?? "user";
      if (from === "user") {
        const c = convs[`dm:${b.to}`]; post(c, "user", b.text); return json(200, { reply: await deliver(c, b.to) });
      }
      const id = `dm:${[from, b.to].sort().join("+")}`;
      const c = ensureConv(id, "dm", `${[from, b.to].sort().join(" ↔ ")}`, [b.to]); emit({ type: "state" });
      post(c, from, b.text); return json(200, { reply: await deliver(c, b.to) });
    }
    if ((m = url.match(/^\/agents\/([^/]+)\/log$/)) && agents[m[1]]) return json(200, await harness(agents[m[1]], "/log"));
    if ((m = url.match(/^\/agents\/([^/]+)\/health$/)) && agents[m[1]]) return json(200, await harness(agents[m[1]], "/healthz"));
    if (req.method === "DELETE" && (m = url.match(/^\/agents\/([^/]+)$/)) && agents[m[1]]) {
      docker("rm", "-f", agents[m[1]].container); delete agents[m[1]]; saveAgents(); emit({ type: "state" }); return json(200, { deleted: m[1] });
    }
    json(404, { error: "not found" });
  } catch (e) { json(500, { error: String(e instanceof Error ? e.message : e) }); }
}).listen(Number(process.env.PORT ?? 8080), () => console.log("orcie server up on :8080"));
