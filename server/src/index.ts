import { createServer, type ServerResponse } from "node:http";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, createWriteStream, statSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { openDb } from "./db.ts";
import { startPrivateApi } from "./private-api.ts";
import { cleanProfile, managerError, validName, validModel, NAME_RE, type Profile } from "./profile.ts";
import { tmpdir } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Control plane (POC): agents are Docker containers; conversations/rooms are persisted in a JSON file.
// Router rule (docs/DESIGN.md §6): a conversation's messages reach every agent member's session for that conversation.
type Agent = { name: string; model: string; container: string; port: number; created: string; profile?: Profile; res?: Res; kind?: "claude" | "external" | "tmux"; lastSeen?: string; lastReply?: string };
type Item = { id: string; name: string; input: string; result?: string; ok?: boolean };
type FileRef = { id: string; name: string; size: number };
type Msg = { seq: number; from: string; text: string; at: string; activity?: Item[]; hop?: number; to?: string[]; mentions?: string[]; files?: FileRef[] };
type Conv = { id: string; kind: "dm" | "room"; title: string; members: string[]; messages: Msg[]; cursor: Record<string, number>; mode?: "parallel" | "sequential"; origin?: string; async?: boolean };

// Orcie is subscription-only (Claude CLI login). Anthropic API credentials are never used: drop them so nothing inherits them.
for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) delete process.env[k];
import * as tmuxBridge from "./tmux-bridge.ts";
import { guard, wsGuard, loadSecret, agentToken } from "./guard.ts";
import { upgrade } from "./ws-lite.ts";
import * as disk from "./disk.ts";
import { PRESETS as RES_PRESETS, limits, validateRes, plan as resPlan, usageLevel, parseSize, type Res } from "./resources.ts";
import { startAgentApi } from "./agent-api.ts";
import { addressed, wakeTargets, isSilent, isAck, STREAK_LIMIT, streakKind } from "./addressing.ts";
import { Journal, Notes, memoryBlock, hashNotes, participants, label as convLabel } from "./memory.ts";
const STORE = process.env.ORCIE_STORE ?? "agents.json";
const STATE = process.env.ORCIE_STATE ?? "state.json";
const CREDS = process.env.ORCIE_CREDS ?? `${process.env.HOME}/.orcie/creds`;
const IMAGE = "orcie-agent:dev";
const NOVNC = resolvePath(process.env.ORCIE_WEB_DIR ?? `${import.meta.dirname}/../../web`, "novnc");
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
  const r = await fetch(`http://127.0.0.1:${hostPort(a.container)}/send`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${agentToken(SECRET, a.name)}` }, body: JSON.stringify({ ...(body as object), model: a.model }), signal: AbortSignal.timeout(900_000) }); // model is per turn, so it can change without recreating the container
  const dec = new TextDecoder(); let buf = "", reply: string | null = null;
  const line = (l: string) => { if (!l.trim()) return; const e = JSON.parse(l); if (e.kind === "done") reply = e.reply; else if (e.kind === "error") throw new Error(e.error); else onEvent(e); };
  for await (const chunk of r.body as any) { buf += dec.decode(chunk, { stream: true }); let i; while ((i = buf.indexOf("\n")) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } }
  line(buf);
  if (reply === null) throw new Error("agent stream ended without a reply");
  return reply;
}
const summarize = (input: any) => { const v = input?.command ?? input?.file_path ?? input?.url ?? input?.pattern ?? input?.path ?? input?.prompt ?? JSON.stringify(input ?? {}); return String(v).slice(0, 300); };
const harness = async (a: Agent, path: string, init?: RequestInit) =>
  (await fetch(`http://127.0.0.1:${hostPort(a.container)}${path}`, { ...init, headers: { ...(init?.headers as object), authorization: `Bearer ${agentToken(SECRET, a.name)}` }, signal: AbortSignal.timeout(900_000) })).json();

// ---- live events (SSE) ----
const clients = new Set<ServerResponse>();
const emit = (e: unknown) => clients.forEach((c) => c.write(`data: ${JSON.stringify(e)}\n\n`));

// ---- agents (HR) ----
// Auth for agent containers (never an API key). Preferred: a long-lived subscription token from `claude setup-token`
// stored in ~/.orcie/token (does not rotate, safe to share). Fallback: a copy of the host login (scripts/export-login.sh),
// which can go stale when the host or another container refreshes the shared refresh token.
const TOKEN_FILE = process.env.ORCIE_TOKEN_FILE ?? `${process.env.HOME}/.orcie/token`;
const GIT_DIR = process.env.ORCIE_GIT_DIR ?? `${process.env.HOME}/.orcie/git`; // shared git credential (token file), mounted read-only into every agent
const SECRET_FILE = process.env.ORCIE_SECRET_FILE ?? `${process.env.HOME}/.orcie/server-secret`;
const SECRET = loadSecret(SECRET_FILE); // derives each agent's identity token
const UI_PORT = Number(process.env.PORT ?? 8080), AGENT_PORT = Number(process.env.ORCIE_AGENT_PORT ?? 8081);
const readToken = () => (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : "");
// The agent's limits: its own saved values, or the preset named in its profile (legacy agents keep their unlimited volume until a disk limit is set).
const effectiveRes = (a: { profile?: Profile; res?: Res }): Res => a.res ?? { cpus: RES_PRESETS[a.profile?.resources ?? "standard"].cpus, memoryMb: RES_PRESETS[a.profile?.resources ?? "standard"].memoryMb, diskGb: null };
const volumeOf = (name: string, res: Res) => (res.diskGb === null ? `orcie-${name}-data` : disk.volumeName(name));
function runContainer(name: string, model: string, profile?: Profile, resIn?: Res) {
  const token = readToken();
  if (!token && !existsSync(`${CREDS}/.credentials.json`)) throw new Error(`no subscription auth: run \`claude setup-token\` and save it to ${TOKEN_FILE}, or run scripts/export-login.sh`);
  const container = `orcie-${name}`, res = effectiveRes({ profile, res: resIn });
  if (res.diskGb !== null) disk.ensureMounted(name);
  execFileSync("docker", ["run", "-d", "--name", container, "--restart", "unless-stopped", "--cpus", String(res.cpus), "--memory", `${res.memoryMb}m`, "--memory-swap", `${res.memoryMb}m`,
    "-v", `${volumeOf(name, res)}:/data`, ...(token ? ["-e", "CLAUDE_CODE_OAUTH_TOKEN"] : ["-v", `${CREDS}:/creds`]), "-p", "127.0.0.1:0:9090",
    "--add-host", "host.docker.internal:host-gateway",
    ...(existsSync(`${GIT_DIR}/token`) ? ["-v", `${GIT_DIR}:/gitcreds:ro`] : []),
    "-e", `AGENT_NAME=${name}`, "-e", `ORCIE_AGENT_TOKEN=${agentToken(SECRET, name)}`, "-e", `ORCIE_SERVER=http://host.docker.internal:${AGENT_PORT}`, "-e", `ORCIE_MODEL=${model}`,
    ...(profile ? ["-e", `ORCIE_PROFILE=${Buffer.from(JSON.stringify(profile)).toString("base64")}`] : []), IMAGE],
    { encoding: "utf8", env: { ...process.env, ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}) } }); // token passed by env, not on the command line
  return container;
}
function recreateAgent(name: string) { // new container on the same volume (memory, sessions, skills persist), e.g. after changing auth
  const a = agents[name]; if (!a) throw new Error(`no agent ${name}`);
  try { docker("rm", "-f", a.container); } catch { /* already gone */ }
  a.container = runContainer(name, a.model, a.profile, a.res); a.port = hostPort(a.container);
  return a;
}
const MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"];
// Stop: cancel the running turn(s), drop everything queued, and mark what the agent has not read yet as handled.
async function cancelAgent(name: string) {
  const a = agents[name]; if (!a) throw new Error(`no agent ${name}`);
  epochs.set(name, epochOf(name) + 1);
  const active = [...(inflight.get(name) ?? [])];
  for (const k of [...dirty]) if (k.endsWith(`|${name}`)) dirty.delete(k);
  for (const c of Object.values(convs)) if (participants(c).includes(name) && c.messages.length) { c.cursor[name] = c.messages.at(-1)!.seq; db.setCursor(c.id, name, c.cursor[name]); }
  if (a.kind === "external") for (const id of [...(pending.get(name) ?? [])]) clearPending(name, id);
  else if (a.kind === "tmux") tmuxBridge.interrupt(a.container);
  else { try { await harness(a, "/cancel", { method: "POST" }); } catch { /* container down: nothing to stop */ } }
  for (const id of active) { const c = convs[id]; if (c) { post(c, "system", `${name} was stopped by the user.`); emit({ type: "typing", conv: id, agent: name, on: false }); } }
  emit({ type: "state" }); return { stopped: name, conversations: active };
}
async function waitHealthy(a: Agent) { for (let i = 0; i < 40; i++) { try { if ((await harness(a, "/healthz")).ok) return; } catch { /* still starting */ } await new Promise((r) => setTimeout(r, 1000)); } }
async function restartAgent(name: string) { // restart the container's process (same container, same volume)
  const a = agents[name]; if (!a || a.kind === "external" || a.kind === "tmux") throw new Error("only container agents can be restarted");
  await cancelAgent(name); docker("restart", a.container); a.port = hostPort(a.container);
  await waitHealthy(a); emit({ type: "state" }); return { restarted: name };
}
function setModel(name: string, model: unknown) { // live: the harness gets the model on every turn, nothing is recreated
  const a = agents[name]; if (!a || a.kind === "external" || a.kind === "tmux") throw new Error("only container agents have a model setting");
  if (!validModel(model)) throw new Error("invalid model name");
  a.model = model; db.putAgent(a); emit({ type: "state" }); return { name, model };
}
// Workspace archive: a tar.gz of the agent's /data (workspace, memory files, browser profile minus caches), written before a lay off
// so nothing is lost for good, or streamed to the browser as a download. Reads the volume read-only through a throwaway container.
const ARCHIVE_DIR = process.env.ORCIE_ARCHIVE_DIR ?? `${process.env.HOME}/.orcie/archives`;
const tarArgs = (a: Agent) => ["run", "--rm", "--user", "root", "--entrypoint", "tar", "-v", `${volumeOf(a.name, effectiveRes(a))}:/data:ro`, IMAGE, "czf", "-", "-C", "/data", "--exclude=./home/.cache", "--exclude=./home/.config/chromium/*/Cache", "--exclude=./home/.config/chromium/*/Code Cache", "."];
function archiveWorkspace(a: Agent): Promise<{ file: string; bytes: number }> {
  mkdirSync(ARCHIVE_DIR, { recursive: true, mode: 0o700 });
  const file = `${ARCHIVE_DIR}/${a.name}-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`, out = createWriteStream(file, { mode: 0o600 });
  return new Promise((resolve, reject) => {
    const p = spawn("docker", tarArgs(a), { stdio: ["ignore", "pipe", "pipe"] }); let err = ""; p.stderr.on("data", (d) => (err += d)); p.stdout.pipe(out);
    p.on("close", (code) => { out.end(() => { const bytes = statSync(file).size; if (code === 0 && bytes > 0) resolve({ file, bytes }); else { try { rmSync(file); } catch { /* none */ } reject(new Error(`could not archive the workspace (${err.trim().slice(-200) || `tar exit ${code}`}); nothing was deleted`)); } }); });
  });
}
// Lay off an agent: its container and volume are deleted and it leaves every room, but all conversation history stays
// (messages, rooms, the DM). Its long-term notes are archived, not deleted. With archive, the workspace is saved first and the
// lay off is aborted if that fails.
async function removeAgent(name: string, opts: { archive?: boolean } = {}) {
  const a = agents[name]; if (!a) throw new Error(`no agent ${name}`);
  const container = a.kind !== "external" && a.kind !== "tmux";
  let workspaceArchive: { file: string; bytes: number } | null = null;
  if (container && opts.archive) workspaceArchive = await archiveWorkspace(a);
  epochs.set(name, epochOf(name) + 1);
  if (container) {
    try { docker("rm", "-f", a.container); } catch { /* already gone */ }
    if (a.res?.diskGb != null) { try { disk.destroy(name); } catch (e) { console.error(`disk cleanup for ${name}: ${e}`); } }
    try { docker("volume", "rm", "-f", `orcie-${name}-data`); } catch { /* none */ }
  }
  for (const c of Object.values(convs)) if (c.kind === "room" && c.members.includes(name)) { c.members = c.members.filter((n) => n !== name); db.delMember(c.id, name); post(c, "system", `${name} was removed from the team.`); }
  for (const k of [...dirty]) if (k.endsWith(`|${name}`)) dirty.delete(k);
  pending.delete(name); db.delAgent(name); db.delMemstate(name); delete agents[name]; diskUse.delete(name); diskLevel.delete(name);
  let archived: string | null = null;
  const nd = `${NOTES_DIR}/${name}`;
  if (existsSync(nd)) { archived = `${NOTES_DIR}/_retired/${name}-${Date.now()}`; mkdirSync(`${NOTES_DIR}/_retired`, { recursive: true, mode: 0o700 }); renameSync(nd, archived); }
  journal.rebuild(Object.values(convs)); emit({ type: "state" });
  return { deleted: name, volumeRemoved: container, notesArchivedTo: archived, workspaceArchive: workspaceArchive?.file ?? null, workspaceArchiveBytes: workspaceArchive?.bytes ?? null };
}
// ---- resources: CPU, memory, disk and model per agent, one panel (GET/POST /api/agents/:name/resources) ----
const diskUse = new Map<string, { used: number; size: number; at: number }>(), diskLevel = new Map<string, number>();
let factsCache: { at: number; v: ReturnType<typeof disk.hostFacts> } | null = null;
const facts = () => (factsCache && Date.now() - factsCache.at < 300_000 ? factsCache.v : (factsCache = { at: Date.now(), v: disk.hostFacts() }).v);
const boundsNow = () => { const f = facts(); return limits(f.cpus, f.memMb, f.diskGb); };
async function readDisk(a: Agent, res: Res) { // used/size of the agent's data. Limited volumes: the filesystem itself; legacy volumes: du of /data
  if (res.diskGb !== null) { const [, size, used] = (await dockerAsync("exec", a.container, "df", "-B1", "--output=source,size,used", "/data")).split("\n").pop()!.trim().split(/\s+/); return { used: Number(used), size: Number(size) }; }
  return { used: Number((await dockerAsync("exec", a.container, "du", "-sb", "/data")).split(/\s/)[0]), size: 0 };
}
async function resourceInfo(name: string) {
  const a = agents[name]; if (!a || a.kind === "external" || a.kind === "tmux") throw new Error("only container agents have resource limits");
  const res = effectiveRes(a); let usage: any = { running: false };
  try {
    const st = JSON.parse(await dockerAsync("stats", "--no-stream", "--format", "{{json .}}", a.container));
    usage = { running: true, cpuPct: parseFloat(st.CPUPerc), memory: st.MemUsage, memoryPct: parseFloat(st.MemPerc) };
    const [used] = st.MemUsage.split("/").map((x: string) => x.trim()); usage.memoryUsedMb = parseSize(used.replace("iB", ""), "mb", "m");
    const d = await readDisk(a, res); usage.diskUsedBytes = d.used; usage.diskSizeBytes = d.size; if (res.diskGb !== null) diskUse.set(name, { ...d, at: Date.now() });
  } catch { /* container not running */ }
  let backup = false; if (res.diskGb !== null) { try { await dockerAsync("volume", "inspect", `orcie-${name}-data`); backup = true; } catch { /* none */ } }
  return { name, model: a.model, models: MODELS, res, bounds: boundsNow(), presets: RES_PRESETS, preset: a.profile?.resources ?? "standard", usage, browser: a.profile?.tools.browser !== false, busy: (inflight.get(name)?.size ?? 0) > 0, legacyDisk: res.diskGb === null, backupVolume: backup ? `orcie-${name}-data` : null };
}
class Conflict extends Error { info: unknown; constructor(msg: string, info: unknown) { super(msg); this.info = info; } }
async function applyResources(name: string, b: any) {
  const a = agents[name]; if (!a || a.kind === "external" || a.kind === "tmux") throw new Error("only container agents have resource limits");
  const cur = effectiveRes(a), { res: next, warnings } = validateRes(b, cur, boundsNow(), a.profile?.tools.browser !== false);
  if (b.model !== undefined && !validModel(b.model)) throw new Error("invalid model name");
  let used: number | null = null; try { used = (await readDisk(a, cur)).used; } catch { /* container down */ }
  const p = resPlan(cur, next, used); if (p.error) throw new Error(p.error);
  if (next.diskGb !== null && cur.diskGb === null) { const need = ((used ?? 0) * 1.1) / 2 ** 30; if (disk.vmFreeGb() < need) throw new Error(`not enough free space in the Docker VM to move the workspace (needs about ${need.toFixed(1)} GB)`); }
  const busy = (inflight.get(name)?.size ?? 0) > 0;
  if (p.restart.length) {
    if (!b.confirmRestart) throw new Conflict("this change restarts the agent", { needsRestart: p.restart, busy, warnings });
    if (busy && !b.force) throw new Conflict("the agent is working right now; wait for it to finish or stop it first", { busy: true, needsRestart: p.restart });
  }
  const changed: string[] = [];
  if (b.model !== undefined && b.model !== a.model) { setModel(name, b.model); changed.push(`model ${a.model}`); }
  if (p.restart.length) { // recreate on the same volume: stop, move or resize the disk, start again with the new limits
    await cancelAgent(name); docker("stop", a.container);
    try {
      if (cur.diskGb === null) disk.migrate(name, `orcie-${name}-data`, next.diskGb!, IMAGE); else if (next.diskGb !== cur.diskGb) disk.shrink(name, next.diskGb!);
    } catch (e) { try { docker("start", a.container); } catch { /* leave it stopped */ } throw new Error(`disk change failed, nothing was changed: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`); }
    a.res = next; recreateAgent(name); await waitHealthy(a);
  } else {
    if (next.cpus !== cur.cpus || next.memoryMb !== cur.memoryMb) docker("update", "--cpus", String(next.cpus), "--memory", `${next.memoryMb}m`, "--memory-swap", `${next.memoryMb}m`, a.container);
    if (next.diskGb !== cur.diskGb && next.diskGb !== null) disk.grow(name, next.diskGb);
    a.res = next;
  }
  if (next.cpus !== cur.cpus) changed.push(`${next.cpus} CPU`); if (next.memoryMb !== cur.memoryMb) changed.push(`${next.memoryMb / 1024} GB memory`); if (next.diskGb !== cur.diskGb) changed.push(`${next.diskGb} GB disk`);
  db.putAgent(a); diskLevel.delete(name); const dm = convs[`dm:${name}`]; if (dm && changed.length) post(dm, "system", `${name}'s resources changed: ${changed.join(", ")}${p.restart.length ? " (the agent was restarted on the same volume)" : ""}.`);
  emit({ type: "state" }); return { ...(await resourceInfo(name)), warnings, restarted: p.restart.length > 0 };
}
// Disk watch: ext4 refuses writes at 100% (ENOSPC), the watch tells the agent's DM at 80%, 95% and when full.
async function diskWatch() {
  for (const a of Object.values(agents)) {
    if (a.kind === "external" || a.kind === "tmux" || !a.res || a.res.diskGb === null) continue;
    try {
      const d = await readDisk(a, a.res); diskUse.set(a.name, { ...d, at: Date.now() });
      const lvl = usageLevel(d.used, d.size), prev = diskLevel.get(a.name) ?? 0, dm = convs[`dm:${a.name}`];
      if (lvl > prev && dm) post(dm, "system", lvl === 100 ? `${a.name}'s disk is full (${(d.size / 2 ** 30).toFixed(0)} GB): writes now fail. Free space or raise the limit in Manage > Resources and model.` : `${a.name}'s disk is ${Math.round((d.used / d.size) * 100)}% full of ${(d.size / 2 ** 30).toFixed(0)} GB.`);
      if (lvl !== prev && (lvl > prev || d.used / d.size < 0.75)) diskLevel.set(a.name, lvl);
    } catch { /* container not running */ }
  }
}
if (process.env.ORCIE_DISK_WATCH !== "0") setInterval(() => diskWatch().catch(() => {}), 60_000).unref();

// Edit an agent's HR profile after hiring. Role text, skills, team/manager etc. apply immediately; tools and resources need a recreate.
async function editProfile(name: string, incoming: any) {
  const a = agents[name]; if (!a) throw new Error(`no agent ${name}`);
  const old = a.profile ?? cleanProfile({ role: "Assistant" });
  const next = cleanProfile({ ...old, ...incoming });
  const err = managerError(name, next.manager, (n) => agents[n]?.profile?.manager, (n) => !!agents[n]); if (err) throw new Error(err);
  a.profile = next; db.putAgent(a);
  if (a.kind !== "external" && a.kind !== "tmux") { try { const r = await hbrowser(a, "/profile", "POST", { profile: next }); if (!r.ok) throw new Error(String(r.status)); } catch (e) { throw new Error(`saved, but the agent could not apply it right now (${String((e as Error).message ?? e)}); restart the agent to re-apply`); } }
  emit({ type: "state" });
  if (next.resources !== old.resources && a.kind !== "external" && a.kind !== "tmux") { const pr = RES_PRESETS[next.resources]; await applyResources(name, { cpus: pr.cpus, memoryMb: pr.memoryMb, ...(effectiveRes(a).diskGb === null ? {} : { diskGb: pr.diskGb }) }); } // the preset is a quick pick: it changes the live limits
  return { profile: next, needsRecreate: next.tools.browser !== old.tools.browser };
}
function createAgent(name: string, model: string, profile?: Profile, want?: any) { // want: optional {cpus, memoryMb, diskGb} (diskGb: null = no size limit)
  if (!validName(name)) throw new Error("name must be lowercase letters/digits/dashes");
  if (agents[name]) throw new Error(`agent ${name} exists`);
  if (profile) { const err = managerError(name, profile.manager, (n) => agents[n]?.profile?.manager, (n) => !!agents[n]); if (err) throw new Error(err); }
  const pr = RES_PRESETS[profile?.resources ?? "standard"]; let diskNote = "";
  let res: Res | undefined = validateRes(want?.diskGb === null ? { ...want, diskGb: undefined } : want, { cpus: pr.cpus, memoryMb: pr.memoryMb, diskGb: pr.diskGb }, boundsNow(), profile?.tools.browser !== false).res;
  if (want?.diskGb === null) res = { ...res, diskGb: null };
  try { if (res.diskGb !== null) disk.create(name, res.diskGb); } catch (e) { res = { ...res, diskGb: null }; diskNote = `could not create a size-limited disk (${String((e as Error).message ?? e).split("\n")[0].slice(0, 120)}); this agent's volume has no size limit`; }
  let container: string;
  try { container = runContainer(name, model, profile, res); } catch (e) { if (res?.diskGb != null) { try { disk.destroy(name); } catch { /* best effort */ } } throw e; }
  agents[name] = { name, model, container, port: hostPort(container), created: new Date().toISOString(), ...(res ? { res } : {}), ...(profile ? { profile } : {}) };
  db.putAgent(agents[name]);
  const dm = ensureConv(`dm:${name}`, "dm", name, [name]);
  if (!existsSync(`${GIT_DIR}/token`)) post(dm, "system", `${name} has no GitHub access: the shared credential is missing. Run scripts/export-git-login.sh, then \`cli/orcie recreate ${name}\`.`);
  if (diskNote) post(dm, "system", `${name}: ${diskNote}.`);
  if (profile) post(dm, "system", `${name} was onboarded as ${profile.role}: ${profile.skills.length} skill${profile.skills.length === 1 ? "" : "s"}, ${profile.tools.browser ? "browser enabled" : "no browser"}, ${profile.resources} resources.`);
  emit({ type: "state" });
  return agents[name];
}

// ---- conversations ----
function ensureConv(id: string, kind: Conv["kind"], title: string, members: string[]) {
  if (!convs[id]) { convs[id] = { id, kind, title, members, messages: [], cursor: {} }; db.putConv(convs[id]); }
  return convs[id];
}
const journal = new Journal(); journal.rebuild(Object.values(convs)); // long-term memory: derived from stored history on every start
const FILES_DIR = process.env.ORCIE_FILES_DIR ?? `${process.env.HOME}/.orcie/files`;
const MAX_FILE = 25 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
function saveFile(name: unknown, b64: unknown, by: string): FileRef {
  const clean = String(name ?? "file").split(/[\\/]/).pop()!.replace(/[\\/\u0000-\u001f]/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
  const data = Buffer.from(String(b64 ?? ""), "base64"); if (!data.length) throw new Error("empty file");
  if (data.length > MAX_FILE) throw new Error(`file too large (max ${MAX_FILE / 1024 / 1024} MB)`);
  const id = randomBytes(12).toString("hex"); mkdirSync(FILES_DIR, { recursive: true, mode: 0o700 }); writeFileSync(`${FILES_DIR}/${id}`, data, { mode: 0o600 });
  db.addFile({ id, name: clean, size: data.length, type: IMAGE_TYPES[clean.split(".").pop()!.toLowerCase()] ?? "application/octet-stream", by });
  return { id, name: clean, size: data.length };
}
const fileRefs = (ids: unknown): FileRef[] => (Array.isArray(ids) ? ids : []).slice(0, 10).map((id) => db.getFile(String(id))).filter(Boolean).map((f: any) => ({ id: f.id, name: f.name, size: f.size }));
// An agent may read a file only if it is attached to a message in a conversation the agent takes part in (or it uploaded it).
const agentCanRead = (who: string, id: string) => db.getFile(id)?.by === who || Object.values(convs).some((c) => participants(c).includes(who) && c.messages.some((m) => m.files?.some((f) => f.id === id)));
const NOTES_DIR = process.env.ORCIE_MEMORY_DIR ?? `${process.env.HOME}/.orcie/memory`;
const notes = new Notes(NOTES_DIR);
function post(c: Conv, from: string, text: string, activity?: Item[], hop?: number, files?: FileRef[]) {
  const m: Msg = { seq: (c.messages.at(-1)?.seq ?? 0) + 1, from, text, at: new Date().toISOString(), ...(activity?.length ? { activity } : {}), ...(hop !== undefined ? { hop } : {}), ...(files?.length ? { files } : {}) };
  if (c.kind === "room" && from !== "system") { // who this message is for (saved so the UI and the recipients can tell asked from mentioned)
    const a = addressed(text, c.members.filter((n) => n !== from), !agents[from]);
    if (a.broadcast) m.to = ["@here"]; else if (a.asked.length) m.to = a.asked;
    if (a.mentioned.length) m.mentions = a.mentioned;
  }
  c.messages.push(m); db.addMsg(c.id, m); journal.onPost(c, m); emit({ type: "message", conv: c.id, msg: m });
  return m;
}

// Deliver everything the agent hasn't seen in this conversation, run a turn, post the reply.
// In rooms, if new messages land while the agent is drafting, the draft is held and the agent re-reads everything
// (pass 2) before posting a revised reply or staying silent, so it never answers without having taken in the latest.
const fmtMsgs = (ms: Msg[]) => ms.map((m) => `[${m.from}] ${m.text}${m.files?.length ? `\n[Attachments: ${m.files.map((f) => `${f.name} (${f.size} bytes, id ${f.id})`).join(", ")}. Fetch one with: fetch_file <id> [save-as-path]]` : ""}`).join("\n");
// ---- external (bridged) agents, e.g. Muse ----
// No container and no Claude: messages addressed to them wait in an inbox that the bridge client polls over the private
// API (docs/PRIVATE_API.md); replies are posted back as that agent. Online/offline comes from the client's last request.
const ONLINE_MS = 90_000;
const pending = new Map<string, Set<string>>(); // external agent -> conversations with messages waiting for it
for (const r of db.loadPending()) (pending.get(r.agent) ?? pending.set(r.agent, new Set()).get(r.agent)!).add(r.conv);
const isExternal = (n: string) => agents[n]?.kind === "external";
const isTmux = (n: string) => agents[n]?.kind === "tmux"; // existing Claude Code session on the host (container field holds the tmux session name)
const online = (a: Agent) => !!a.lastSeen && Date.now() - Date.parse(a.lastSeen) < ONLINE_MS;
const agentView = (a: Agent) => ({ name: a.name, model: a.model, kind: a.kind ?? "claude", profile: a.profile, ...(a.kind === "tmux" ? { online: tmuxBridge.sessionAlive(a.container), session: a.container, lastReply: a.lastReply ?? null } : {}), ...(a.kind === "external" ? { online: online(a), lastSeen: a.lastSeen ?? null, lastReply: a.lastReply ?? null, waiting: pending.get(a.name)?.size ?? 0 } : {}) });
function touchExternal(name: string) { const a = agents[name]; if (!a) return; const was = online(a); a.lastSeen = new Date().toISOString(); db.putAgent(a); if (!was) emit({ type: "state" }); }
const clearPending = (agent: string, conv: string) => { if (pending.get(agent)?.delete(conv)) { db.delPending(agent, conv); emit({ type: "state" }); } };
function enqueueExternal(c: Conv, agent: string): string | null {
  if (!c.messages.some((m) => m.seq > (c.cursor[agent] ?? 0) && m.from !== agent && m.from !== "system")) return null;
  if (!pending.get(agent)?.has(c.id)) { (pending.get(agent) ?? pending.set(agent, new Set()).get(agent)!).add(c.id); db.addPending(agent, c.id); emit({ type: "state" }); }
  return `(queued for ${agent}, an external agent. It replies in this conversation when it next checks in${online(agents[agent]) ? "" : "; it is offline right now"}.)`;
}
const mv = (m: Msg) => ({ seq: m.seq, from: m.from, text: m.text, at: m.at });
function inboxFor(name: string) {
  const out: any[] = [];
  for (const id of [...(pending.get(name) ?? [])]) {
    const c = convs[id]; if (!c) { clearPending(name, id); continue; }
    const cur = c.cursor[name] ?? 0, unseen = c.messages.filter((m) => m.seq > cur && m.from !== name && m.from !== "system");
    if (!unseen.length) { clearPending(name, id); continue; }
    const reason = c.kind === "dm" ? "dm" : unseen.some((m) => new RegExp(`@${name}\\b`).test(m.text)) ? "mention" : "room"; // why it is here: direct message, @mention, or general room traffic
    out.push({ conversation: c.id, kind: c.kind, reason, title: c.title, ...(c.kind === "room" ? { members: c.members } : {}), upto: c.messages.at(-1)!.seq,
      messages: unseen.map(mv), context: c.messages.filter((m) => m.seq <= cur && m.from !== "system").slice(-10).map(mv) });
  }
  return out;
}
function ackFor(name: string, convId: string, upto: number) { // mark everything up to `upto` as seen by the external agent
  const c = convs[convId]; if (!c) throw new Error("no such conversation");
  c.cursor[name] = Math.max(c.cursor[name] ?? 0, Math.min(upto, c.messages.at(-1)?.seq ?? 0)); db.setCursor(c.id, name, c.cursor[name]);
  if (!c.messages.some((m) => m.seq > c.cursor[name] && m.from !== name && m.from !== "system")) clearPending(name, c.id);
}
function replyAs(name: string, convId: string, text: string, upto?: number) {
  const c = convs[convId]; if (!c) throw new Error("no such conversation");
  const isPair = c.id.includes("+"), member = c.kind === "room" ? c.members.includes(name) : isPair ? c.id.slice(3).split("+").includes(name) : c.id === `dm:${name}`;
  if (!member) throw new Error(`${name} is not part of ${c.id}`);
  ackFor(name, c.id, upto ?? c.messages.at(-1)?.seq ?? 0);
  workingExternal(name, c.id, false);
  const m = post(c, name, text); agents[name].lastReply = m.at; db.putAgent(agents[name]);
  route(c, m); emit({ type: "state" }); return m;
}
const workTimers = new Map<string, ReturnType<typeof setTimeout>>();
function workingExternal(name: string, conv: string, on: boolean) { // lets the bridge show "muse is working" while it composes (auto-clears after 2 min)
  const k = `${name}|${conv}`; clearTimeout(workTimers.get(k)); workTimers.delete(k);
  emit({ type: "typing", conv, agent: name, on });
  if (on) workTimers.set(k, setTimeout(() => { workTimers.delete(k); emit({ type: "typing", conv, agent: name, on: false }); }, 120_000));
}
function createExternalAgent(name: string) {
  if (!validName(name)) throw new Error("name must be lowercase letters/digits/dashes");
  if (agents[name]) throw new Error(`agent ${name} exists`);
  agents[name] = { name, model: "external", container: "", port: 0, created: new Date().toISOString(), kind: "external" }; db.putAgent(agents[name]);
  const dm = ensureConv(`dm:${name}`, "dm", name, [name]);
  post(dm, "system", `${name} joined as an external agent: no container, it talks to orcie through the private API.`);
  emit({ type: "state" }); return agentView(agents[name]);
}

function createTmuxAgent(name: string, session: string) {
  if (!validName(name)) throw new Error("name must be lowercase letters/digits/dashes");
  if (agents[name]) throw new Error(`agent ${name} exists`);
  tmuxBridge.checkLinkable(session);
  if (Object.values(agents).some((a) => a.kind === "tmux" && a.container === session)) throw new Error(`session ${session} is already linked`);
  agents[name] = { name, model: "host-tmux", container: session, port: 0, created: new Date().toISOString(), kind: "tmux" }; db.putAgent(agents[name]);
  const dm = ensureConv(`dm:${name}`, "dm", name, [name]);
  post(dm, "system", `${name} is linked to the tmux session "${session}" on the host. Messages are typed into that session and its reply is read back from its Claude transcript when it finishes. It runs on the Mac as you, outside any container.`);
  emit({ type: "state" }); return agentView(agents[name]);
}
async function deliverTmux(c: Conv, agent: string): Promise<string | null> {
  const unseen = c.messages.filter((m) => m.seq > (c.cursor[agent] ?? 0) && m.from !== agent && m.from !== "system");
  if (!unseen.length) return null;
  const upto = c.messages.at(-1)!.seq, hop = Math.max(...unseen.map((m) => m.hop ?? 0)) + 1;
  emit({ type: "typing", conv: c.id, agent, on: true });
  const ep = epochOf(agent), items: Item[] = [];
  const onEvent = (e: any) => { // same shape as container agents' tool events, so the UI shows the live tool banner
    if (e.kind === "tool") { const item = { id: e.id, name: e.name, input: summarize(e.input) }; items.push(item); emit({ type: "activity", conv: c.id, agent, item }); }
    else if (e.kind === "tool_result") { const it = items.find((x) => x.id === e.id); if (it) { it.result = e.preview; it.ok = e.ok; emit({ type: "activity", conv: c.id, agent, update: { id: e.id, result: e.preview, ok: e.ok } }); } }
  };
  try {
    let text = fmtMsgs(unseen);
    if (c.kind === "room") text = `(Orcie chat room "${c.title}", members: user, ${c.members.join(", ")}. Reply as a normal chat message, or exactly NO_REPLY if you have nothing to add.)\n${text}`;
    else if (c.id.includes("+")) text += "\n\n(If this needs no response, reply exactly NO_REPLY.)";
    const reply = (await tmuxBridge.turn({ session: agents[agent].container, from: c.kind === "room" ? `room:${c.title}` : unseen.at(-1)!.from, text, conv: c.id, onEvent })).trim();
    if (epochOf(agent) !== ep) return null; // stopped by the user
    c.cursor[agent] = upto; db.setCursor(c.id, agent, upto);
    if (reply && !isSilent(reply)) { const m = post(c, agent, reply, items, hop); agents[agent].lastReply = m.at; db.putAgent(agents[agent]); route(c, m); }
    return reply;
  } catch (e) {
    c.cursor[agent] = upto; db.setCursor(c.id, agent, upto);
    post(c, "system", `${agent} failed: ${String(e).slice(0, 300)}`); return null;
  } finally { emit({ type: "typing", conv: c.id, agent, on: false }); }
}

const inflight = new Map<string, Set<string>>(); // agent -> conversations it is working in right now
const epochs = new Map<string, number>(); // bumped when the user stops an agent; turns started earlier drop their result
const epochOf = (a: string) => epochs.get(a) ?? 0;
const active = new Map<string, number>(); // in-flight turns per conversation (for the private API's wait)
async function deliver(c: Conv, agent: string): Promise<string | null> {
  if (isExternal(agent)) return enqueueExternal(c, agent);
  if (isTmux(agent)) return deliverTmux(c, agent);
  active.set(c.id, (active.get(c.id) ?? 0) + 1); (inflight.get(agent) ?? inflight.set(agent, new Set()).get(agent)!).add(c.id);
  try { return await deliverInner(c, agent); } finally { active.set(c.id, (active.get(c.id) ?? 1) - 1); inflight.get(agent)?.delete(c.id); }
}
async function deliverInner(c: Conv, agent: string): Promise<string | null> {
  const unseenOf = () => c.messages.filter((m) => m.seq > (c.cursor[agent] ?? 0) && m.from !== agent);
  if (!unseenOf().length) return null;
  emit({ type: "typing", conv: c.id, agent, on: true });
  const ep = epochOf(agent), items: Item[] = [];
  const onEvent = (e: any) => {
    if (e.kind === "text") items.push({ id: `say${items.length}`, name: "say", input: String(e.text).slice(0, 4000) }); // narration before the answer goes into the message's work log
    else if (e.kind === "tool") { const item = { id: e.id, name: e.name, input: summarize(e.input) }; items.push(item); emit({ type: "activity", conv: c.id, agent, item }); }
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
      if (c.id.includes("+") && c.id.slice(3).split("+").some(isExternal)) text += "\n\n(If this needs no response, reply exactly NO_REPLY.)"; // lets an agent end an exchange with an external agent
      const note = addrNote(c, agent, unseen);
      if (c.kind === "room") {
        text = pass === 0
          ? `You are in the chat room "${c.title}" (members: user, ${c.members.join(", ")}), a live group chat like a team Slack channel.\n\n${earlier.length ? `Earlier in the room (context):\n${fmtMsgs(earlier)}\n\n` : ""}New since you last looked:\n${text}\n\nFirst take in everything above, including what the other members have said, and understand where the discussion stands. Then decide whether you have something to contribute: answer questions, build on or push back on others' points, ask follow-ups (use @name to address someone), and move things toward what the user asked for. Avoid filler like "agreed" and don't repeat what was already said. If, having considered all of it, you have nothing to add right now, reply exactly NO_REPLY. Others may be drafting at the same moment as you.`
          : `While you were drafting, new messages arrived:\n${text}\n\nYour unposted draft was:\n${draft}\n\nTaking everything now said into account, reply with your final message (revise your draft, or drop whatever has already been covered), or reply exactly NO_REPLY if it is now redundant.`;
      }
      if (note) text += `\n\n${note}`;
      const open = db.listPromises(agent, "active").reverse(), cutoff = new Date().toISOString();
      const n = [notes.read(agent), open.length ? `Your open promises (commitments you made; close them with: promise done <id>):\n${open.map((p: any) => `#${p.id} ${p.text}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
      const mem = memoryBlock({ agent, conv: c, incoming: unseen.map((m) => m.text).join("\n"), notes: n, journal, state: db.memGet(agent, c.id) });
      if (mem) text = `${mem}\n\n${text}`;
      reply = (await turn(agents[agent], { from: c.kind === "room" ? `room:${c.title}` : unseen.at(-1)!.from, text, conversation: c.id }, onEvent)).trim();
      db.memSet(agent, c.id, cutoff, hashNotes(n)); // this conversation's session has now seen everything up to the cutoff
      if (epochOf(agent) !== ep) return null; // stopped by the user: the queue was cleared, post nothing
      c.cursor[agent] = upto; db.setCursor(c.id, agent, upto);
      const arrived = c.messages.some((m) => m.seq > upto && m.from !== agent && m.from !== "system");
      if (c.kind === "room" && pass === 0 && reply && !isSilent(reply) && arrived) { draft = reply; continue; } // hold and reconsider
      const worked = items.some((i) => i.name !== "say");
      if (items.at(-1)?.name === "say" && items.at(-1)!.input.trim() === reply.trim()) items.pop(); // the final answer is the message itself, not work log
      if (reply && !isSilent(reply) && !(c.kind === "room" && !worked && isAck(reply))) route(c, post(c, agent, reply, items, hop));
      break;
    }
    return reply;
  } catch (e) {
    if (epochOf(agent) !== ep || /cancelled/.test(String(e))) return null; // cancel() already told the room
    post(c, "system", `${agent} failed: ${String(e).slice(0, 300)}`);
    return null;
  } finally { emit({ type: "typing", conv: c.id, agent, on: false }); }
}
// Orca-style note on why this turn happened and where the answer goes.
function addrNote(c: Conv, agent: string, unseen: Msg[]): string {
  const to = new Set(unseen.flatMap((m) => m.to ?? [])), mentions = new Set(unseen.flatMap((m) => m.mentions ?? []));
  const out: string[] = [];
  if (c.kind === "room") {
    if (to.has(agent)) out.push("You were asked directly: always answer what was asked, briefly and with the substance (if you answered before, give the answer again or what changed; never just say you already answered).");
    else if (to.has("@here")) out.push("This went to everyone. Reply only with your own part or information nobody else has; if others will cover it, reply NO_REPLY.");
    else if (mentions.has(agent)) out.push("You were only MENTIONED in passing; nobody asked you anything. Take any action that is yours, but reply NO_REPLY unless what was said about you is wrong or someone is blocked on you.");
    else if (unseen.some((m) => !agents[m.from] && m.from !== "system") && !to.size) out.push("The user spoke to the room without naming anyone: say something only if you own the topic or hold information nobody else has.");
    else out.push("You were NOT addressed. Default to NO_REPLY. Speak only if you own the topic, hold information nobody else has posted, or see a real problem (wrong fact, risk, blocked work).");
  }
  const o = c.origin && convs[c.origin];
  if (o && c.id.includes("+")) out.push(`This DM was started from ${o.kind === "room" ? `#${o.title}` : "your conversation with the user"}; when you have what was needed there, report it with: send_message "${o.kind === "room" ? `#${o.title}` : "user"}" "<text>".`);
  return out.length ? `(${out.join(" ")} To stay silent, reply with exactly NO_REPLY and nothing else; never explain why you are silent.)` : "";
}

// ---- routing ----
// Every posted message is delivered to every other member's session at the same moment. Each (conversation, agent)
// has its own serial worker: if the agent is mid-turn, new messages are batched into its next turn (cursor-based),
// so agents never wait on each other. Agent-to-agent discussion continues freely until a per-human-message budget
// is spent (see the circuit breaker below), which bounds loops without cutting threads short.
const running = new Set<string>(), dirty = new Set<string>();
function kick(c: Conv, agent: string) {
  const k = `${c.id}|${agent}`;
  if (running.has(k)) return void dirty.add(k);
  running.add(k);
  (async () => { do { dirty.delete(k); await deliver(c, agent); } while (dirty.has(k)); })().finally(() => running.delete(k));
}
const chains = new Map<string, Promise<unknown>>();
// Circuit breaker: after STREAK_LIMIT agent messages in a row with no message from the human, fan-out pauses (a visible
// notice is posted once) and resumes when the human posts. Computed from history, so it survives restarts.
const humanIdx = (c: Conv) => c.messages.findLastIndex((x) => !agents[x.from] && x.from !== "system");
const streak = (c: Conv) => c.messages.slice(humanIdx(c) + 1).filter((x) => agents[x.from]).length;
const limitOf = (c: Conv) => Number(process.env.ORCIE_STREAK_LIMIT) || STREAK_LIMIT[streakKind(c)];
const isPaused = (c: Conv) => streak(c) >= limitOf(c);
function pauseNotice(c: Conv) {
  if (c.messages.slice(humanIdx(c) + 1).some((x) => x.from === "system" && x.text.startsWith("Paused fan-out"))) return;
  post(c, "system", `Paused fan-out: ${streak(c)} agent messages in a row without you. Post here to resume.`);
}
function route(c: Conv, m: Msg) {
  if (m.from === "system") return;
  const human = !agents[m.from];
  if (!human && isPaused(c)) return void pauseNotice(c);
  if (c.kind === "dm") {
    const pair = c.id.includes("+") ? c.id.slice(3).split("+") : null;
    if (!pair) { const t = c.members[0]; if (m.from !== t) kick(c, t); return; } // dm:<agent>: anyone else (user, API client, external agent) triggers it
    if (human) return void pair.filter((n) => agents[n]).forEach((n) => kick(c, n)); // the user posting in an agent<->agent DM wakes both (and resumes a paused one)
    const other = pair.find((n) => n !== m.from); // sync DMs (/dm) are answered inline; async ones (send_message) and external/tmux agents continue through the queue
    if (other && agents[other] && (c.async || isExternal(m.from) || isExternal(other) || isTmux(other))) kick(c, other);
    return;
  }
  if (c.mode === "sequential") { // legacy: user message, agents answer one after another
    if (!human) return;
    const run = async () => { for (const a of c.members.filter((n) => n !== m.from)) await deliver(c, a); };
    return void chains.set(c.id, (chains.get(c.id) ?? Promise.resolve()).then(run, run));
  }
  const others = c.members.filter((n) => n !== m.from);
  const targets = wakeTargets(addressed(m.text, others, human), others, human); // asked, mentioned and @here wake; everyone else catches up on their next turn
  targets.forEach((a) => kick(c, a));
}

// ---- onboarding (Agent HR) ----
// A tool-less Claude call interviews the manager about the agent's purpose, then drafts the profile.
const clean = cleanProfile;
const hrPrompt = (name: string, model: string, history: { role: string; text: string }[], current: Profile | null) =>
  `You are the HR onboarding specialist for an AI-agent platform. Each agent is a Claude CLI instance in its own Docker container with a shell, file access, persistent memory, an optional headless-browser tool (Playwright), and optional skills (SKILL.md playbooks). You are co-designing the configuration of a new agent named "${name}" (model ${model}) with the manager, through an ongoing conversation. You maintain a draft profile that the manager sees live next to the chat.

Each turn:
1. Reply to the manager in 1-4 short sentences: either ask ONE clarifying question (purpose, typical tasks, systems/sites/tools, tone, boundaries, what success looks like), or say concretely what you changed and why. Do not repeat the whole profile in the chat.
2. As soon as you can propose anything (after the first answer at the latest), or whenever you change something, end your reply with the COMPLETE updated profile in one \`\`\`json block with keys: role (short title), summary (one sentence), systemPrompt (markdown instructions to the agent in second person: duties, workflow, tone, boundaries), tools ({"browser": boolean}), skills (0-5 items of {name (kebab-case), description (when to use it), instructions (markdown steps)}), memorySeed (markdown facts the agent should always remember), resources ("small" | "standard" | "large"), greeting (one sentence the agent says when introduced), team (team name, only if mentioned), manager (an existing agent it reports to, only if mentioned), responsibilities (0-8 short strings), description (one short paragraph for the agent directory). Omit the block only while you still know nothing about the agent's purpose.
3. The manager may edit the profile by hand between turns. The current profile below is the source of truth: keep their edits unless they ask you to change them.

Current profile: ${current ? JSON.stringify(current) : "(none yet)"}

Conversation so far:
${history.map((h) => `${h.role === "user" ? "MANAGER" : "HR"}: ${h.text}`).join("\n") || "(none yet: greet the manager briefly and ask your first question)"}`;
function claudeOnce(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("claude", ["-p", "--output-format", "json", "--tools", "", "--model", "claude-sonnet-5-5"], { cwd: mkdtempSync(`${tmpdir()}/orcie-hr-`), env: process.env });
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

const uiServer = createServer(async (req, res) => {
  const json = (code: number, b: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  try {
    const bad = guard(UI_PORT, { method: req.method, host: req.headers.host, origin: req.headers.origin, contentType: req.headers["content-type"] });
    if (bad) return json(bad.status, { error: bad.error });
    const url = (req.url ?? "").split("?")[0]; let m0: RegExpMatchArray | null;
    if (req.method === "GET" && (url === "/" || url === "/index.html" || /^\/(dm|room)\/[^/]+$/.test(url))) { // the page itself; /dm/<agent>, /room/<name>, /dm/<a>+<b> open that conversation (the UI reads the path)
      res.writeHead(200, { "content-type": "text/html" }); return void res.end(readFileSync(WEB));
    }
    if (req.method === "GET" && url.startsWith("/novnc/")) { // vendored noVNC client for the live-browser panel
      const f = resolvePath(NOVNC, `.${decodeURIComponent(url.slice(6))}`);
      if (!f.startsWith(`${NOVNC}/`) || !existsSync(f)) return json(404, { error: "not found" });
      res.writeHead(200, { "content-type": f.endsWith(".js") ? "application/javascript" : f.endsWith(".css") ? "text/css" : "application/octet-stream" }); return void res.end(readFileSync(f));
    }
    if ((m0 = url.match(/^\/api\/agents\/([^/]+)\/browser\/(state|control|screenshot|active|take|release|cancel|type|restart)$/))) return void (await browserApi(m0[1], m0[2], req.method ?? "GET", req.headers["content-type"] ? await readJson(req) : {}, res));
    if (url === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": ok\n\n"); clients.add(res); return void req.on("close", () => clients.delete(res));
    }
    let raw = ""; for await (const c of req) raw += c;
    const b = raw ? JSON.parse(raw) : {};
    let m: RegExpMatchArray | null;

    if (url === "/healthz") return json(200, { ok: true });
    if (req.method === "GET" && url === "/api/state") return json(200, { agents: Object.values(agents).map(agentView), conversations: Object.values(convs).map(view) });
    if ((m = url.match(/^\/api\/conversations\/([^/]+)$/)) && req.method === "GET") {
      const c = convs[decodeURIComponent(m[1])]; return c ? json(200, c) : json(404, { error: "no such conversation" });
    }
    if ((m = url.match(/^\/api\/conversations\/([^/]+)\/messages$/)) && req.method === "POST") {
      const c = convs[decodeURIComponent(m[1])]; if (!c) return json(404, { error: "no such conversation" });
      const files = fileRefs(b.files), text = String(b.text ?? "");
      if (!text.trim() && !files.length) return json(400, { error: "empty message" });
      const msg = post(c, "user", text || "(attachment)", undefined, 0, files); route(c, msg); return json(202, msg);
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
    if ((m = url.match(/^\/api\/agents\/([^/]+)\/recreate$/)) && req.method === "POST") { if (isExternal(m[1]) || isTmux(m[1])) return json(400, { error: "this agent has no container" }); return json(200, recreateAgent(m[1])); }
    if (req.method === "GET" && url === "/api/tmux") return json(200, { sessions: tmuxBridge.listSessions(), linked: Object.values(agents).filter((a) => a.kind === "tmux").map((a) => ({ agent: a.name, session: a.container })) });
    if (req.method === "POST" && url === "/agents/tmux") return json(201, createTmuxAgent(b.name, b.session));
    if (req.method === "POST" && url === "/agents/external") return json(201, createExternalAgent(b.name));
    if (req.method === "GET" && url === "/api/git") { // does every container agent have the shared GitHub credential? (?verify=1 also calls GitHub from inside each container)
      const verify = new URL(req.url!, "http://x").searchParams.get("verify") === "1", token = existsSync(`${GIT_DIR}/token`);
      const rows = Object.values(agents).filter((a) => a.kind !== "external" && a.kind !== "tmux").map((a) => {
        let mounted = false, user: string | null = null;
        try { mounted = docker("inspect", "-f", "{{range .Mounts}}{{.Destination}} {{end}}", a.container).split(" ").includes("/gitcreds"); } catch { /* container missing */ }
        if (verify && mounted) { try { user = docker("exec", a.container, "gh", "api", "user", "--jq", ".login"); } catch { /* no access */ } }
        return { name: a.name, mounted, ...(verify ? { githubUser: user, ok: !!user } : {}) };
      });
      return json(200, { tokenFile: token, agents: rows, external: Object.values(agents).filter((a) => a.kind === "external").map((a) => a.name) });
    }
    if (req.method === "GET" && url === "/api/auth") return json(200, { mode: readToken() ? "token" : existsSync(`${CREDS}/.credentials.json`) ? "host-login-copy" : "none" });
    if (req.method === "GET" && url === "/agents") return json(200, Object.values(agents));
    if ((m = url.match(/^\/api\/agents\/([^/]+)\/profile$/)) && req.method === "POST") {
      if (!agents[m[1]]) return json(404, { error: "no such agent" });
      try { return json(200, await editProfile(m[1], b.profile ?? b)); } catch (e) { return json(400, { error: String(e instanceof Error ? e.message : e) }); }
    }
    if (req.method === "POST" && url === "/api/files") { try { return json(201, saveFile(b.name, b.data, "user")); } catch (e) { return json(400, { error: String(e instanceof Error ? e.message : e) }); } }
    if ((m = url.match(/^\/api\/files\/([0-9a-f]{24})$/)) && req.method === "GET") {
      const f = db.getFile(m[1]); if (!f || !existsSync(`${FILES_DIR}/${f.id}`)) return json(404, { error: "no such file" });
      const inline = new URL(req.url!, "http://x").searchParams.has("inline") && f.type !== "application/octet-stream"; // only known image types are ever shown inline
      res.writeHead(200, { "content-type": inline ? f.type : "application/octet-stream", "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`, "x-content-type-options": "nosniff", "content-security-policy": "sandbox", "cache-control": "private, max-age=3600" });
      return void res.end(readFileSync(`${FILES_DIR}/${f.id}`));
    }
    if (req.method === "GET" && url === "/api/promises") { const q = new URL(req.url!, "http://x").searchParams; return json(200, { promises: db.listPromises(q.get("agent") ?? undefined, q.get("status") ?? undefined) }); }
    if ((m = url.match(/^\/api\/promises\/(\d+)$/)) && req.method === "POST") { // the human can close or reopen an agent's commitment
      const p = db.getPromise(Number(m[1])); if (!p) return json(404, { error: "no such promise" });
      if (!["active", "done", "cancelled"].includes(b.status)) return json(400, { error: "status must be active, done or cancelled" });
      db.setPromise(p.id, b.status, b.note ? String(b.note).slice(0, 500) : null); emit({ type: "promises", agent: p.agent }); return json(200, db.getPromise(p.id));
    }
    if (req.method === "GET" && url === "/api/browser/sessions") return json(200, { sessions: Object.fromEntries(browserSessions) });
    if (req.method === "GET" && url === "/api/activity") return json(200, { busy: [...inflight].filter(([, v]) => v.size).map(([agent, v]) => ({ agent, conversations: [...v] })) });
    if (req.method === "GET" && url === "/api/stats") return json(200, await fleetStats());
    if (req.method === "GET" && url === "/api/check") { const only = new URL(req.url!, "http://x").searchParams.get("agent"); return json(200, { agents: await Promise.all(Object.values(agents).filter((a) => a.kind !== "external" && a.kind !== "tmux" && (!only || a.name === only)).map((a) => checkAgent(a))) }); }
    if ((m = url.match(/^\/api\/agents\/([^/]+)\/resources$/)) && agents[m[1]] && (req.method === "GET" || req.method === "POST")) {
      try { return json(200, req.method === "GET" ? await resourceInfo(m[1]) : await applyResources(m[1], b)); } catch (e) { return e instanceof Conflict ? json(409, { error: e.message, ...(e.info as object) }) : json(400, { error: String((e as Error).message ?? e) }); }
    }
    if ((m = url.match(/^\/api\/agents\/([^/]+)\/backup$/)) && req.method === "DELETE" && agents[m[1]]) { // frees the old unlimited volume kept after a disk migration
      if (new URL(req.url!, "http://x").searchParams.get("confirm") !== m[1]) return json(400, { error: `confirmation required: repeat the agent's name (?confirm=${m[1]})` });
      if (agents[m[1]].res?.diskGb == null) return json(400, { error: "this agent's only volume is its live one; nothing to drop" });
      try { docker("volume", "rm", `orcie-${m[1]}-data`); return json(200, { dropped: `orcie-${m[1]}-data` }); } catch { return json(404, { error: "no backup volume" }); }
    }
    if ((m = url.match(/^\/api\/agents\/([^/]+)\/archive$/)) && req.method === "GET" && agents[m[1]] && agents[m[1]].kind !== "external" && agents[m[1]].kind !== "tmux") { // download the workspace as tar.gz
      const a = agents[m[1]]; res.writeHead(200, { "content-type": "application/gzip", "content-disposition": `attachment; filename="${a.name}-workspace.tar.gz"`, "x-content-type-options": "nosniff" });
      const p = spawn("docker", tarArgs(a), { stdio: ["ignore", "pipe", "ignore"] }); p.stdout.pipe(res); res.on("close", () => p.kill()); return;
    }
    if (req.method === "GET" && url === "/api/models") return json(200, { models: MODELS });
    if ((m = url.match(/^\/api\/agents\/([^/]+)\/(cancel|restart|model)$/)) && req.method === "POST") {
      if (!agents[m[1]]) return json(404, { error: "no such agent" });
      try { return json(200, m[2] === "cancel" ? await cancelAgent(m[1]) : m[2] === "restart" ? await restartAgent(m[1]) : setModel(m[1], b.model)); } catch (e) { return json(400, { error: String(e.message ?? e) }); }
    }
    if (req.method === "POST" && url === "/agents") return json(201, createAgent(b.name, b.model ?? "claude-sonnet-5-5", b.profile ? clean(b.profile) : undefined, b.resources));
    if (req.method === "POST" && url === "/dm") { // the human (UI/CLI) talking to an agent; agents use the authenticated agent listener
      if (!agents[b.to]) return json(404, { error: `no agent ${b.to}` });
      const c = convs[`dm:${b.to}`]; post(c, "user", b.text); return json(200, { reply: await deliver(c, b.to) });
    }
    if ((m = url.match(/^\/agents\/([^/]+)\/log$/)) && agents[m[1]]) return json(200, await harness(agents[m[1]], "/log"));
    if ((m = url.match(/^\/agents\/([^/]+)\/health$/)) && agents[m[1]]) return json(200, await harness(agents[m[1]], "/healthz"));
    if (req.method === "DELETE" && (m = url.match(/^\/(?:api\/)?agents\/([^/]+)$/)) && agents[m[1]]) { // lay off: needs the agent's name as confirmation
      if (new URL(req.url!, "http://x").searchParams.get("confirm") !== m[1]) return json(400, { error: `confirmation required: repeat the agent's name (?confirm=${m[1]})` });
      try { return json(200, await removeAgent(m[1], { archive: new URL(req.url!, "http://x").searchParams.get("archive") === "1" })); } catch (e) { return json(500, { error: String((e as Error).message ?? e) }); }
    }
    json(404, { error: "not found" });
  } catch (e) { json(500, { error: String(e instanceof Error ? e.message : e) }); }
});
uiServer.on("upgrade", (req, sock, head) => { // live browser: VNC relayed over a WebSocket, human only
  const m = (req.url ?? "").split("?")[0].match(/^\/api\/agents\/([^/]+)\/browser\/vnc-ws$/);
  const bad = wsGuard(UI_PORT, { host: req.headers.host, origin: req.headers.origin, peer: req.socket.remoteAddress });
  const a = m && agents[decodeURIComponent(m[1])];
  if (bad || !a || a.kind === "external" || a.kind === "tmux") return void sock.end(`HTTP/1.1 ${bad?.status ?? 404} ${bad ? "Forbidden" : "Not Found"}\r\n\r\n`);
  const ws = upgrade(req, sock, head); if (!ws) return;
  const p = spawn("docker", ["exec", "-i", a.container, "orcie-vncpipe"], { stdio: ["pipe", "pipe", "ignore"] });
  p.stdout.on("data", (d: Buffer) => ws.send(d)); p.on("exit", () => ws.close());
  ws.onMessage = (x) => { if (!p.stdin.destroyed) p.stdin.write(x.data); }; ws.onClose = () => { p.stdin.end(); p.kill(); };
}).listen(UI_PORT, process.env.ORCIE_HOST ?? "127.0.0.1", () => console.log(`orcie server up on ${process.env.ORCIE_HOST ?? "127.0.0.1"}:${process.env.PORT ?? 8080}`));

// Private token-authenticated API for a trusted remote client over Tailscale (docs/PRIVATE_API.md).
startPrivateApi({
  agents, convs, post, route, isExternal, touch: touchExternal, inbox: inboxFor, working: workingExternal, ack: ackFor, reply: replyAs, status: (n) => (agents[n] ? agentView(agents[n]) : null),
  busy: (id) => (active.get(id) ?? 0) > 0 || [...running].some((k) => k.startsWith(id + "|")),
  authMode: () => (readToken() ? "token" : existsSync(`${CREDS}/.credentials.json`) ? "host-login-copy" : "none"),
});

function pairConv(from: string, to: string, origin?: string) {
  const id = `dm:${[from, to].sort().join("+")}`;
  const c = ensureConv(id, "dm", `${[from, to].sort().join(" ↔ ")}`, [to]); emit({ type: "state" });
  if (origin && origin !== c.id && convs[origin] && participants(convs[origin]).includes(from) && c.origin !== origin) { c.origin = origin; db.putConv(c); } // remember where this started, to report back there
  return c;
}
async function agentDm(from: string, to: string, text: string, origin?: string) { // sync agent->agent DM; `from` comes from the caller's token
  if (!agents[to]) throw new Error(`no agent ${to}`);
  const c = pairConv(from, to, origin);
  if (isPaused(c)) { pauseNotice(c); return `(Paused fan-out: ${streak(c)} agent messages in a row in this DM without the user. The user must post in ${c.id} to resume; tell the user if this is blocking you.)`; }
  post(c, from, text); return deliver(c, to);
}
// send_message: asynchronous delivery to the user, a #channel, or another agent (who answers in their own time).
async function sendMessage(from: string, target: string, text: string, origin?: string): Promise<string> {
  if (!text.trim()) throw new Error("empty message");
  if (target === "user") { const c = convs[`dm:${from}`]; if (!c) throw new Error("no DM with the user"); post(c, from, text); return "sent to the user"; }
  if (target.startsWith("#")) {
    const c = Object.values(convs).find((x) => x.kind === "room" && x.title.toLowerCase() === target.slice(1).toLowerCase() && x.members.includes(from));
    if (!c) throw new Error(`you are not in a room called ${target}`);
    if (isPaused(c)) { pauseNotice(c); return `paused: ${target} has had ${streak(c)} agent messages in a row; the user must post there to resume`; }
    route(c, post(c, from, text)); return `posted to ${target}`;
  }
  if (!agents[target]) throw new Error(`no agent or room "${target}" (use "user", "#room" or an agent name)`);
  if (target === from) throw new Error("cannot message yourself");
  const c = pairConv(from, target, origin);
  if (!c.async) { c.async = true; db.putConv(c); }
  if (isPaused(c)) { pauseNotice(c); return `paused: this DM has had ${streak(c)} agent messages in a row; the user must post in ${c.id} to resume`; }
  post(c, from, text); kick(c, target); return `sent to ${target}; they will answer in ${c.id}${c.origin ? ` and report back in ${c.origin === `dm:${from}` ? "your DM with the user" : `#${convs[c.origin].title}`}` : ""}`;
}
const mine = (who: string) => Object.values(convs).filter((c) => participants(c).includes(who));
function findConv(who: string, ref: string) {
  const r = ref.trim().replace(/^#/, "").toLowerCase();
  return mine(who).find((c) => c.id.toLowerCase() === ref.trim().toLowerCase() || (c.kind === "room" && c.title.toLowerCase() === r) || convLabel(c, who).toLowerCase() === ref.trim().toLowerCase());
}
const fmtJ = (m: { at: string; label: string; from: string; text: string }, who: string) => `${m.at.slice(5, 16).replace("T", " ")} ${m.label} [${m.from === who ? "you" : m.from}]: ${m.text.replace(/\n/g, " ").slice(0, 600)}`;
async function agentExtra(who: string, method: string, url: string, b: any, origin?: string): Promise<{ code: number; body: unknown } | null> {
  if (method !== "POST") return null;
  if (url === "/send_message") { try { return { code: 200, body: { text: await sendMessage(who, String(b.to ?? ""), String(b.text ?? ""), origin) } }; } catch (e) { return { code: 400, body: { error: String(e.message ?? e) } }; } }
  if (url === "/browser/request") { // the agent asks the human to take over its browser, then waits for it to come back
    const a = agents[who]; if (!a || a.kind === "external" || a.kind === "tmux") return { code: 400, body: { error: "no browser" } };
    try {
      const reason = String(b.reason ?? "help needed").slice(0, 500); await hbrowser(a, "/browser/control/request", "POST", { reason });
      const dm = convs[`dm:${who}`]; if (dm) post(dm, "system", `${who} needs your help in its browser: ${reason}. Open the Browser panel and take control.`);
      emit({ type: "browser", agent: who, event: "request", reason }); browserWaiting.add(who);
      try { const c = await (await hbrowser(a, "/browser/control/wait?timeout=900", "GET", undefined, 910_000)).json() as any;
        return { code: 200, body: { text: c.holder === "agent" && !c.pending ? (c.note ? `The human handed the browser back. Note: ${c.note}` : c.reason ? "The human handed the browser back." : "The request was dismissed; continue without it or explain what you need.") : "Still waiting for the human (timed out); try again later or tell the user." } }; }
      finally { browserWaiting.delete(who); }
    } catch (e) { return { code: 503, body: { error: String(e.message ?? e) } }; }
  }
  if (url === "/files/upload" && method === "POST") { // the agent shares a file in the conversation its turn belongs to
    const c = origin ? convs[origin] : undefined; if (!c || !participants(c).includes(who)) return { code: 400, body: { error: "no conversation to share into (this works from inside a conversation turn)" } };
    try { const f = saveFile(b.name, b.data, who); route(c, post(c, who, String(b.caption ?? "").slice(0, 2000) || f.name, undefined, undefined, [f])); return { code: 200, body: { text: `shared ${f.name} (${f.size} bytes) in ${c.id}` } }; } catch (e) { return { code: 400, body: { error: String(e.message ?? e) } }; } }
  if (url === "/files/get") { const id = String(b.id ?? ""), f = /^[0-9a-f]{24}$/.test(id) ? db.getFile(id) : null;
    if (!f || !existsSync(`${FILES_DIR}/${id}`) || !agentCanRead(who, id)) return { code: 404, body: { error: "no such file that you can read" } };
    return { code: 200, body: { name: f.name, dataBase64: readFileSync(`${FILES_DIR}/${id}`).toString("base64") } }; }
  if (url === "/promises/add") { const t = String(b.text ?? "").trim().slice(0, 500); if (!t) return { code: 400, body: { error: "text required" } };
    const id = db.addPromise(who, t, origin && convs[origin] && participants(convs[origin]).includes(who) ? origin : null, b.note ? String(b.note).slice(0, 500) : null); emit({ type: "promises", agent: who }); return { code: 200, body: { text: `promise #${id} recorded` } }; }
  if (url === "/promises/list") { const st = b.status ? String(b.status) : "active"; const rows = db.listPromises(who, st === "all" ? undefined : st);
    return { code: 200, body: { text: rows.length ? rows.map((p: any) => `#${p.id} [${p.status}] ${p.text}${p.conv ? ` (from ${p.conv})` : ""}${p.note ? ` - ${p.note}` : ""}`).join("\n") : "(no promises)" } }; }
  if (url === "/promises/update") { const p = db.getPromise(Number(b.id)); if (!p || p.agent !== who) return { code: 404, body: { error: "no such promise of yours" } };
    if (!["active", "done", "cancelled"].includes(b.status)) return { code: 400, body: { error: "status must be active, done or cancelled" } };
    db.setPromise(p.id, b.status, b.note ? String(b.note).slice(0, 500) : null); emit({ type: "promises", agent: who }); return { code: 200, body: { text: `promise #${p.id} marked ${b.status}` } }; }
  if (url === "/memory/remember") { try { notes.remember(who, String(b.text ?? "")); return { code: 200, body: { ok: true } }; } catch (e) { return { code: 400, body: { error: String(e.message ?? e) } }; } }
  if (url === "/memory/recall") {
    const q = String(b.query ?? ""), nl = notes.search(who, q), hits = journal.related(who, null, q, { k: 15 });
    const text = [nl.length ? `Notes:\n${nl.join("\n")}` : "", hits.length ? `History:\n${hits.map((m) => fmtJ(m, who)).join("\n")}` : ""].filter(Boolean).join("\n\n") || "(nothing found)";
    return { code: 200, body: { text } };
  }
  if (url === "/rooms/read") {
    const c = findConv(who, String(b.room ?? "")); if (!c) return { code: 404, body: { error: `no conversation "${b.room}" that you take part in. Yours: ${mine(who).map((x) => x.kind === "room" ? `#${x.title}` : x.id).join(", ")}` } };
    const lim = Math.min(Math.max(Number(b.limit) || 30, 1), 100);
    return { code: 200, body: { text: `${convLabel(c, who)} (${c.id}), latest ${Math.min(lim, c.messages.length)} of ${c.messages.length}:\n` + c.messages.slice(-lim).map((m) => `${m.at.slice(5, 16).replace("T", " ")} [${m.from === who ? "you" : m.from}]: ${m.text.replace(/\n/g, " ").slice(0, 600)}`).join("\n") } };
  }
  return null;
}
startAgentApi({ port: AGENT_PORT, host: process.env.ORCIE_HOST ?? "127.0.0.1", secret: SECRET, agentNames: () => Object.keys(agents), dm: agentDm, extra: agentExtra });

// ---- live browser (picture-in-picture panel) ----
const readJson = async (req: AsyncIterable<Buffer | string>) => { let r = ""; for await (const c of req) r += c; return r ? JSON.parse(r) : {}; };
const hbrowser = (a: Agent, path: string, method = "GET", body?: unknown, ms = 20_000) =>
  fetch(`http://127.0.0.1:${hostPort(a.container)}${path}`, { method, headers: { authorization: `Bearer ${agentToken(SECRET, a.name)}`, "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}), signal: AbortSignal.timeout(ms) });
const browserWaiting = new Set<string>(); // agents blocked in browser_help
async function browserApi(name: string, action: string, method: string, b: any, res: ServerResponse) {
  const send = (code: number, o: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const a = agents[name]; if (!a) return send(404, { error: "no such agent" });
  if (a.kind === "external" || a.kind === "tmux") return send(400, { error: "this agent has no container browser" });
  const mutate = method === "POST";
  if (["state", "control", "screenshot", "active"].includes(action) === mutate) return send(405, { error: "method not allowed" });
  try {
    const r = await hbrowser(a, action === "take" || action === "release" || action === "cancel" ? `/browser/control/${action}` : `/browser/${action}`, method, b);
    if (action === "screenshot") { res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "image/png", "cache-control": "no-store" }); return void res.end(Buffer.from(await r.arrayBuffer())); }
    const out = await r.json() as any; if (!r.ok) return send(r.status, out);
    const dm = convs[`dm:${name}`];
    if (action === "take" && dm) post(dm, "system", "You took control of the browser.");
    if (action === "release" && dm) {
      post(dm, "system", `You handed the browser back to ${name}.${out.note ? ` Note: ${out.note}` : ""}`);
      if (out.note && !browserWaiting.has(name)) route(dm, post(dm, "user", `(I finished in the browser and handed it back to you. ${out.note})`)); // the agent was not waiting: tell it
    }
    if (mutate) emit({ type: "browser", agent: name, control: out });
    return send(200, out);
  } catch (e) { return send(503, { error: `browser unavailable: ${String(e).slice(0, 150)}` }); }
}

// ---- fleet operations: in-container checks, stats, keeping agents on the current image ----
const dockerAsync = (...a: string[]) => new Promise<string>((resolve, reject) => execFile("docker", a, { encoding: "utf8", timeout: 20_000, env: process.env }, (e, out) => (e ? reject(e) : resolve(out.trim()))));
async function checkAgent(a: Agent) {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const add = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
  const sh = async (script: string) => dockerAsync("exec", a.container, "sh", "-c", script);
  try { await dockerAsync("inspect", "-f", "{{.State.Running}}", a.container); } catch { add("container", false, "not running"); return { agent: a.name, ok: false, checks }; }
  add("container", true, "running");
  try { const img = await dockerAsync("inspect", "-f", "{{.Image}}", a.container), cur = await dockerAsync("image", "inspect", "-f", "{{.Id}}", IMAGE); add("image", img === cur, img === cur ? "current" : "outdated: run `orcie recreate " + a.name + "`"); } catch (e) { add("image", false, String(e).slice(0, 80)); }
  const tools = ["claude", "node", "git", "gh", "playwright-mcp", "xdotool", "Xvfb", "x11vnc", "import", "remember", "recall", "read_room", "send_message", "promise", "share_file", "fetch_file", "browser_help", "orcie-dm"];
  try { const out = await sh(`for t in ${tools.join(" ")}; do command -v $t >/dev/null || echo $t; done`); add("tools", !out, out ? `missing: ${out.split("\n").join(", ")}` : `${tools.length} present`); } catch (e) { add("tools", false, String(e).slice(0, 80)); }
  try { const out = await sh('if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then echo token; elif [ -f "$HOME/.claude/.credentials.json" ]; then echo login-copy; else echo none; fi; claude --version 2>&1 | head -1'); const [mode, ver] = out.split("\n"); add("auth", mode !== "none", `${mode} (claude ${ver})`); } catch (e) { add("auth", false, String(e).slice(0, 80)); }
  try { const st = await (await hbrowser(a, "/browser/state", "GET", undefined, 8000)).json() as any; if (st.control?.enabled === false) add("browser", true, "disabled by this agent's profile"); else add("browser", !!st.running, st.running ? `running (${st.url ?? "blank"})` : "not running"); } catch { add("browser", false, "harness unreachable"); }
  try { const out = await sh('gh api user --jq .login 2>&1 | head -1'); add("github", /^[A-Za-z0-9-]+$/.test(out), out.slice(0, 60)); } catch { add("github", false, "no access"); }
  try { const code = await sh('curl -s -o /dev/null -w "%{http_code}" --max-time 5 -X POST "$ORCIE_SERVER/dm" -H "content-type: application/json" -d "{}"'); add("orcie-api", code === "401" || code === "400", `agent API answered ${code}`); } catch { add("orcie-api", false, "cannot reach the server from the container"); }
  return { agent: a.name, ok: checks.every((c) => c.ok), checks };
}
async function fleetStats() {
  let docker_: Record<string, any> = {};
  try { for (const l of (await dockerAsync("stats", "--no-stream", "--format", "{{json .}}")).split("\n").filter(Boolean)) { const j = JSON.parse(l); docker_[j.Name] = j; } } catch { /* docker unavailable */ }
  return { agents: Object.values(agents).map((a) => {
    const mine = Object.values(convs).filter((c) => participants(c).includes(a.name)), d = docker_[a.container] ?? null;
    return { name: a.name, kind: a.kind ?? "claude", model: a.model, busy: (inflight.get(a.name)?.size ?? 0) > 0, conversations: mine.length, messagesSent: mine.reduce((n, c) => n + c.messages.filter((m) => m.from === a.name).length, 0),
      activePromises: db.listPromises(a.name, "active").length, ...(a.kind !== "external" && a.kind !== "tmux" ? (() => { const r = effectiveRes(a), u = diskUse.get(a.name); return { limits: { cpus: r.cpus, memoryMb: r.memoryMb, diskGb: r.diskGb }, ...(u ? { diskUsedBytes: u.used, diskSizeBytes: u.size } : {}) }; })() : {}), ...(d ? { cpu: d.CPUPerc, memory: d.MemUsage, memoryPct: d.MemPerc } : {}) };
  }) };
}
// On startup, any container agent whose container is missing or built from an older image is recreated on its existing volume.
async function ensureCurrentImage() {
  for (const a of Object.values(agents)) if (a.res?.diskGb != null) { try { disk.ensureMounted(a.name); } catch (e) { console.error(`could not mount ${a.name}'s disk: ${e}`); } }
  diskWatch().catch(() => {});
  if (process.env.ORCIE_AUTO_RECREATE === "0") return;
  let cur = ""; try { cur = await dockerAsync("image", "inspect", "-f", "{{.Id}}", IMAGE); } catch { return; }
  for (const a of Object.values(agents)) {
    if (a.kind === "external" || a.kind === "tmux") continue;
    let img = ""; try { img = await dockerAsync("inspect", "-f", "{{.Image}}", a.container); } catch { /* missing */ }
    if (img === cur) continue;
    try { console.log(`recreating ${a.name} (${img ? "image out of date" : "container missing"})`); recreateAgent(a.name); db.putAgent(a); } catch (e) { console.error(`could not recreate ${a.name}: ${e}`); }
  }
  emit({ type: "state" });
}
ensureCurrentImage().catch((e) => console.error("image check", e));

// ---- browser session watcher: tells the UI when an agent starts/stops using its browser (drives the inline live view) ----
type BSession = { active: boolean; reason: string; id: number; since: number; url?: string | null; title?: string | null };
const browserSessions = new Map<string, BSession>();
const bPorts = new Map<string, number>();
let bBusy = false;
async function pollBrowserSessions() {
  if (bBusy || !clients.size) return; bBusy = true;
  try {
    await Promise.all(Object.values(agents).filter((a) => (a.kind ?? "claude") === "claude" && a.profile?.tools?.browser !== false).map(async (a) => {
      try {
        let port = bPorts.get(a.container); if (!port) { port = hostPort(a.container); bPorts.set(a.container, port); }
        const j = await (await fetch(`http://127.0.0.1:${port}/browser/active`, { headers: { authorization: `Bearer ${agentToken(SECRET, a.name)}` }, signal: AbortSignal.timeout(1500) })).json() as BSession;
        const prev = browserSessions.get(a.name); browserSessions.set(a.name, j);
        if (!prev ? j.active : prev.active !== j.active || prev.reason !== j.reason || prev.id !== j.id || (j.active && prev.url !== j.url)) emit({ type: "browser-session", agent: a.name, ...j });
      } catch { bPorts.delete(a.container); }
    }));
  } finally { bBusy = false; }
}
setInterval(() => { pollBrowserSessions().catch(() => {}); }, 2000).unref();
