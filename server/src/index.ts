import { createServer, type ServerResponse } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, renameSync } from "node:fs";
import { openDb } from "./db.ts";
import { tmpdir } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Control plane (POC): agents are Docker containers; conversations/rooms are persisted in a JSON file.
// Router rule (docs/DESIGN.md §6): a conversation's messages reach every agent member's session for that conversation.
type Skill = { name: string; description: string; instructions: string };
type Profile = { role: string; summary: string; systemPrompt: string; tools: { browser: boolean }; skills: Skill[]; memorySeed: string; resources: keyof typeof PRESETS; greeting?: string };
type Agent = { name: string; model: string; container: string; port: number; created: string; profile?: Profile };
type Item = { id: string; name: string; input: string; result?: string; ok?: boolean };
type Msg = { seq: number; from: string; text: string; at: string; activity?: Item[]; hop?: number };
type Conv = { id: string; kind: "dm" | "room"; title: string; members: string[]; messages: Msg[]; cursor: Record<string, number>; mode?: "parallel" | "sequential" };

const STORE = process.env.ORCIE_STORE ?? "agents.json";
const STATE = process.env.ORCIE_STATE ?? "state.json";
const CREDS = process.env.ORCIE_CREDS ?? `${process.env.HOME}/.orcie/creds`;
const IMAGE = "orcie-agent:dev";
const PRESETS = { small: { cpus: "1", memory: "2g" }, standard: { cpus: "2", memory: "4g" }, large: { cpus: "4", memory: "8g" } } as const;
const WEB = new URL("../../web/index.html", import.meta.url);

// Persistence: local SQLite (see db.ts). Memory holds a working copy; every change is written through.
const db = openDb(process.env.ORCIE_DB ?? "orcie.db");
if (!db.count() && (existsSync(STATE) || existsSync(STORE))) { // one-time import of the earlier JSON files
  const oldAgents: Record<string, Agent> = existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : {};
  const oldConvs: Record<string, Conv> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  Object.values(oldAgents).forEach((a) => db.putAgent(a));
  for (const c of Object.values(oldConvs)) { db.putConv(c); c.messages.forEach((m) => db.addMsg(c.id, m)); Object.entries(c.cursor).forEach(([a, n]) => db.setCursor(c.id, a, n)); }
  for (const f of [STORE, STATE]) if (existsSync(f)) renameSync(f, `${f}.migrated`);
  console.log(`imported ${Object.keys(oldConvs).length} conversations from JSON into SQLite`);
}
const { agents, convs } = db.loadAll() as { agents: Record<string, Agent>; convs: Record<string, Conv> };

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
function createAgent(name: string, model: string, profile?: Profile) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name ?? "")) throw new Error("name must be lowercase letters/digits/dashes");
  if (!existsSync(`${CREDS}/.credentials.json`)) throw new Error(`no subscription login at ${CREDS}; run scripts/export-login.sh`);
  if (agents[name]) throw new Error(`agent ${name} exists`);
  const container = `orcie-${name}`;
  // Subscription login mounted from a private dir. No API key is ever set.
  const res = PRESETS[profile?.resources ?? "standard"] ?? PRESETS.standard;
  docker("run", "-d", "--name", container, "--restart", "unless-stopped", "--cpus", res.cpus, "--memory", res.memory,
    "-v", `orcie-${name}-data:/data`, "-v", `${CREDS}:/creds`, "-p", "127.0.0.1:0:9090",
    "--add-host", "host.docker.internal:host-gateway",
    "-e", `AGENT_NAME=${name}`, "-e", `ORCIE_MODEL=${model}`,
    ...(profile ? ["-e", `ORCIE_PROFILE=${Buffer.from(JSON.stringify(profile)).toString("base64")}`] : []), IMAGE);
  agents[name] = { name, model, container, port: hostPort(container), created: new Date().toISOString(), ...(profile ? { profile } : {}) };
  db.putAgent(agents[name]);
  const dm = ensureConv(`dm:${name}`, "dm", name, [name]);
  if (profile) post(dm, "system", `${name} was onboarded as ${profile.role}: ${profile.skills.length} skill${profile.skills.length === 1 ? "" : "s"}, ${profile.tools.browser ? "browser enabled" : "no browser"}, ${profile.resources} resources.`);
  emit({ type: "state" });
  return agents[name];
}

// ---- conversations ----
function ensureConv(id: string, kind: Conv["kind"], title: string, members: string[]) {
  if (!convs[id]) { convs[id] = { id, kind, title, members, messages: [], cursor: {} }; db.putConv(convs[id]); }
  return convs[id];
}
function post(c: Conv, from: string, text: string, activity?: Item[], hop?: number) {
  const m: Msg = { seq: (c.messages.at(-1)?.seq ?? 0) + 1, from, text, at: new Date().toISOString(), ...(activity?.length ? { activity } : {}), ...(hop !== undefined ? { hop } : {}) };
  c.messages.push(m); db.addMsg(c.id, m); emit({ type: "message", conv: c.id, msg: m });
  return m;
}

// Deliver everything the agent hasn't seen in this conversation, run a turn, post the reply.
// In rooms, if new messages land while the agent is drafting, the draft is held and the agent re-reads everything
// (pass 2) before posting a revised reply or staying silent, so it never answers without having taken in the latest.
const fmtMsgs = (ms: Msg[]) => ms.map((m) => `[${m.from}] ${m.text}`).join("\n");
async function deliver(c: Conv, agent: string): Promise<string | null> {
  const unseenOf = () => c.messages.filter((m) => m.seq > (c.cursor[agent] ?? 0) && m.from !== agent);
  if (!unseenOf().length) return null;
  emit({ type: "typing", conv: c.id, agent, on: true });
  const items: Item[] = [];
  const onEvent = (e: any) => {
    if (e.kind === "tool") { const item = { id: e.id, name: e.name, input: summarize(e.input) }; items.push(item); emit({ type: "activity", conv: c.id, agent, item }); }
    else if (e.kind === "tool_result") { const it = items.find((x) => x.id === e.id); if (it) { it.result = e.preview; it.ok = e.ok; emit({ type: "activity", conv: c.id, agent, update: { id: e.id, result: e.preview, ok: e.ok } }); } }
  };
  try {
    let draft = "", reply = "";
    for (let pass = 0; pass < 2; pass++) {
      const unseen = unseenOf();
      if (!unseen.length) break;
      const upto = c.messages.at(-1)!.seq, hop = Math.max(...unseen.map((m) => m.hop ?? 0)) + 1;
      const earlier = c.messages.filter((m) => m.seq <= (c.cursor[agent] ?? 0) && m.from !== "system").slice(-10);
      let text = fmtMsgs(unseen);
      if (c.kind === "room") {
        text = pass === 0
          ? `You are in the chat room "${c.title}" (members: user, ${c.members.join(", ")}), a live group chat like a team Slack channel.\n\n${earlier.length ? `Earlier in the room (context):\n${fmtMsgs(earlier)}\n\n` : ""}New since you last looked:\n${text}\n\nFirst take in everything above, including what the other members have said, and understand where the discussion stands. Then decide whether you have something to contribute: answer questions, build on or push back on others' points, ask follow-ups (use @name to address someone), and move things toward what the user asked for. Avoid filler like "agreed" and don't repeat what was already said. If, having considered all of it, you have nothing to add right now, reply exactly NO_REPLY. Others may be drafting at the same moment as you.`
          : `While you were drafting, new messages arrived:\n${text}\n\nYour unposted draft was:\n${draft}\n\nTaking everything now said into account, reply with your final message (revise your draft, or drop whatever has already been covered), or reply exactly NO_REPLY if it is now redundant.`;
      }
      reply = (await turn(agents[agent], { from: c.kind === "room" ? `room:${c.title}` : unseen.at(-1)!.from, text, conversation: c.id }, onEvent)).trim();
      c.cursor[agent] = upto; db.setCursor(c.id, agent, upto);
      const arrived = c.messages.some((m) => m.seq > upto && m.from !== agent && m.from !== "system");
      if (c.kind === "room" && pass === 0 && reply && reply !== "NO_REPLY" && arrived) { draft = reply; continue; } // hold and reconsider
      if (reply && reply !== "NO_REPLY") route(c, post(c, agent, reply, items, hop));
      break;
    }
    return reply;
  } catch (e) {
    post(c, "system", `${agent} failed: ${String(e).slice(0, 300)}`);
    return null;
  } finally { emit({ type: "typing", conv: c.id, agent, on: false }); }
}

// ---- routing ----
// Every posted message is delivered to every other member's session at the same moment. Each (conversation, agent)
// has its own serial worker: if the agent is mid-turn, new messages are batched into its next turn (cursor-based),
// so agents never wait on each other. Agent-to-agent discussion continues freely until a per-human-message budget
// is spent (PER_AGENT replies each since the user last spoke), which bounds loops without cutting threads short.
const PER_AGENT = Number(process.env.ORCIE_ROOM_REPLIES ?? 5);
const running = new Set<string>(), dirty = new Set<string>();
function kick(c: Conv, agent: string) {
  const k = `${c.id}|${agent}`;
  if (running.has(k)) return void dirty.add(k);
  running.add(k);
  (async () => { do { dirty.delete(k); await deliver(c, agent); } while (dirty.has(k)); })().finally(() => running.delete(k));
}
const chains = new Map<string, Promise<unknown>>();
function route(c: Conv, m: Msg) {
  if (m.from === "system") return;
  if (c.kind === "dm") return void (m.from === "user" && kick(c, c.members[0]));
  const fromAgent = m.from !== "user";
  const mentioned = c.members.filter((n) => new RegExp(`@${n}\\b`).test(m.text));
  const targets = (mentioned.length ? mentioned : c.members).filter((n) => n !== m.from);
  if (c.mode === "sequential") { // legacy: user message, agents answer one after another
    if (fromAgent) return;
    const run = async () => { for (const a of targets) await deliver(c, a); };
    return void chains.set(c.id, (chains.get(c.id) ?? Promise.resolve()).then(run, run));
  }
  if (fromAgent) { // budget: agent messages since the user last spoke, in total and for this author
    const lastUser = c.messages.findLastIndex((x) => x.from === "user");
    const since = c.messages.slice(lastUser + 1).filter((x) => x.from !== "user" && x.from !== "system");
    if (since.length >= PER_AGENT * c.members.length || since.filter((x) => x.from === m.from).length >= PER_AGENT) return; // they still see it next time they run
  }
  targets.forEach((a) => kick(c, a));
}

// ---- onboarding (Agent HR) ----
// A tool-less Claude call interviews the manager about the agent's purpose, then drafts the profile.
const clean = (p: any): Profile => ({
  role: String(p.role ?? "Assistant").slice(0, 80), summary: String(p.summary ?? "").slice(0, 400),
  systemPrompt: String(p.systemPrompt ?? "").slice(0, 8000), tools: { browser: p.tools?.browser !== false },
  skills: (Array.isArray(p.skills) ? p.skills : []).slice(0, 6).map((s: any) => ({ name: String(s.name ?? "skill").slice(0, 40), description: String(s.description ?? "").slice(0, 300), instructions: String(s.instructions ?? "").slice(0, 6000) })),
  memorySeed: String(p.memorySeed ?? "").slice(0, 4000), resources: p.resources in PRESETS ? p.resources : "standard", greeting: p.greeting ? String(p.greeting).slice(0, 400) : undefined,
});
const hrPrompt = (name: string, model: string, history: { role: string; text: string }[], current: Profile | null) =>
  `You are the HR onboarding specialist for an AI-agent platform. Each agent is a Claude CLI instance in its own Docker container with a shell, file access, persistent memory, an optional headless-browser tool (Playwright), and optional skills (SKILL.md playbooks). You are co-designing the configuration of a new agent named "${name}" (model ${model}) with the manager, through an ongoing conversation. You maintain a draft profile that the manager sees live next to the chat.

Each turn:
1. Reply to the manager in 1-4 short sentences: either ask ONE clarifying question (purpose, typical tasks, systems/sites/tools, tone, boundaries, what success looks like), or say concretely what you changed and why. Do not repeat the whole profile in the chat.
2. As soon as you can propose anything (after the first answer at the latest), or whenever you change something, end your reply with the COMPLETE updated profile in one \`\`\`json block with keys: role (short title), summary (one sentence), systemPrompt (markdown instructions to the agent in second person: duties, workflow, tone, boundaries), tools ({"browser": boolean}), skills (0-5 items of {name (kebab-case), description (when to use it), instructions (markdown steps)}), memorySeed (markdown facts the agent should always remember), resources ("small" | "standard" | "large"), greeting (one sentence the agent says when introduced). Omit the block only while you still know nothing about the agent's purpose.
3. The manager may edit the profile by hand between turns. The current profile below is the source of truth: keep their edits unless they ask you to change them.

Current profile: ${current ? JSON.stringify(current) : "(none yet)"}

Conversation so far:
${history.map((h) => `${h.role === "user" ? "MANAGER" : "HR"}: ${h.text}`).join("\n") || "(none yet: greet the manager briefly and ask your first question)"}`;
function claudeOnce(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("claude", ["-p", "--output-format", "json", "--tools", "", "--model", "claude-sonnet-5-5"], { cwd: mkdtempSync(`${tmpdir()}/orcie-hr-`), env: { ...process.env, ANTHROPIC_API_KEY: "" } });
    let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("error", reject); p.on("close", (code) => { try { resolve(JSON.parse(out).result ?? ""); } catch { reject(new Error(`claude exited ${code}: ${err || out}`.slice(0, 500))); } });
    p.stdin.end(prompt);
  });
}
async function onboardingTurn(name: string, model: string, history: { role: string; text: string }[], current: any) {
  const text = (await claudeOnce(hrPrompt(name, model, history, current ? clean(current) : null))).trim();
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)], last = blocks.at(-1);
  let profile: Profile | null = null;
  if (last) { try { profile = clean(JSON.parse(last[1])); } catch { /* keep the previous profile */ } }
  const message = (last ? text.replace(last[0], "") : text).trim() || (profile ? "I've updated the plan on the right." : "");
  return { message, profile };
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
      const msg = post(c, "user", String(b.text ?? ""), undefined, 0); route(c, msg); return json(202, msg);
    }
    if (req.method === "GET" && url === "/api/search") {
      const q = new URL(req.url!, "http://x").searchParams.get("q") ?? ""; return json(200, { results: db.search(q) });
    }
    if (req.method === "POST" && url === "/api/onboarding") {
      if (!/^[a-z][a-z0-9-]{0,30}$/.test(b.name ?? "")) return json(400, { error: "invalid name" });
      return json(200, await onboardingTurn(b.name, b.model ?? "claude-sonnet-5-5", Array.isArray(b.history) ? b.history : [], b.profile ?? null));
    }
    if (req.method === "POST" && url === "/api/rooms") {
      const members: string[] = (b.members ?? []).filter((n: string) => agents[n]);
      const title = String(b.title ?? "").trim(); if (!title) return json(400, { error: "title required" });
      const id = `room:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      if (convs[id]) return json(409, { error: "room exists" });
      const c = ensureConv(id, "room", title, members); c.mode = b.mode === "sequential" ? "sequential" : "parallel"; db.putConv(c); emit({ type: "state" }); return json(201, view(c));
    }
    if ((m = url.match(/^\/api\/rooms\/([^/]+)\/mode$/)) && req.method === "POST") {
      const c = convs[decodeURIComponent(m[1])]; if (!c || c.kind !== "room") return json(404, { error: "not found" });
      c.mode = b.mode === "sequential" ? "sequential" : "parallel"; db.putConv(c); emit({ type: "state" }); return json(200, view(c));
    }
    if ((m = url.match(/^\/api\/rooms\/([^/]+)\/members$/)) && req.method === "POST") {
      const c = convs[decodeURIComponent(m[1])]; if (!c || c.kind !== "room" || !agents[b.name]) return json(404, { error: "not found" });
      if (!c.members.includes(b.name)) { c.members.push(b.name); db.putConv(c); }
      post(c, "system", `${b.name} joined the room`); emit({ type: "state" }); return json(200, view(c));
    }

    // CLI + in-container tools (orcie-dm)
    if (req.method === "GET" && url === "/agents") return json(200, Object.values(agents));
    if (req.method === "POST" && url === "/agents") return json(201, createAgent(b.name, b.model ?? "claude-sonnet-5-5", b.profile ? clean(b.profile) : undefined));
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
      docker("rm", "-f", agents[m[1]].container); db.delAgent(m[1]); delete agents[m[1]]; emit({ type: "state" }); return json(200, { deleted: m[1] });
    }
    json(404, { error: "not found" });
  } catch (e) { json(500, { error: String(e instanceof Error ? e.message : e) }); }
}).listen(Number(process.env.PORT ?? 8080), () => console.log("orcie server up on :8080"));
