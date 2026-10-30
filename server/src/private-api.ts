import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isIP } from "node:net";

// Private, token-authenticated API for a trusted remote client (e.g. an assistant on a Tailscale VM).
// Single user. Listens ONLY on loopback or a Tailscale address (anything else is refused), never on 0.0.0.0.
// Token lives outside git (~/.orcie/api-token, mode 600). See docs/PRIVATE_API.md.

type Msg = { seq: number; from: string; text: string; at: string; activity?: unknown[] };
type Conv = { id: string; kind: "dm" | "room"; title: string; members: string[]; messages: Msg[]; mode?: string };
type Agent = { name: string; model: string; profile?: { role?: string } };
export type Ctx = {
  agents: Record<string, Agent>; convs: Record<string, Conv>;
  post(c: Conv, from: string, text: string): Msg; route(c: Conv, m: Msg): void;
  busy(convId: string): boolean; authMode(): string;
  isExternal(name: string): boolean; touch(name: string): void; status(name: string): any;
  inbox(name: string): any[]; working(name: string, conv: string, on: boolean): void; ack(name: string, conv: string, upto: number): void; reply(name: string, conv: string, text: string, upto?: number): Msg;
};

const HOME = process.env.HOME!;
const TOKEN_FILE = process.env.ORCIE_API_TOKEN_FILE ?? `${HOME}/.orcie/api-token`;
const AUDIT_FILE = `${HOME}/.orcie/api-audit.log`;
const PORT = Number(process.env.ORCIE_API_PORT ?? 8787);
const DENY = (process.env.ORCIE_API_DENY ?? "kfl-*,remica-*").split(",").map((g) => g.trim()).filter(Boolean)
  .map((g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"));
const denied = (name: string) => DENY.some((r) => r.test(name));

function loadToken(): string {
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();
  mkdirSync(`${HOME}/.orcie`, { recursive: true, mode: 0o700 });
  const t = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600 }); chmodSync(TOKEN_FILE, 0o600);
  console.log(`private API: generated a new token at ${TOKEN_FILE}`);
  return t;
}
const digest = (s: string) => createHash("sha256").update(s).digest();

// Only loopback or Tailscale addresses are acceptable bind targets.
function allowedHost(h: string): boolean {
  if (h === "127.0.0.1" || h === "::1") return true;
  if (isIP(h) === 4) { const [a, b] = h.split(".").map(Number); return a === 100 && b >= 64 && b <= 127; } // CGNAT 100.64.0.0/10 (Tailscale)
  return isIP(h) === 6 && h.toLowerCase().startsWith("fd7a:115c:a1e0:"); // Tailscale ULA
}
function tailscaleIp(): string | null {
  for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try { const ip = execFileSync(bin, ["ip", "-4"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }).trim().split("\n")[0]; if (ip && allowedHost(ip)) return ip; } catch { /* not available */ }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failures = new Map<string, { n: number; until: number }>();

export function startPrivateApi(ctx: Ctx) {
  const token = loadToken(), want = digest(token);
  let server: ReturnType<typeof createServer> | null = null;

  const view = (convId: string, m: Msg) => ({ conv: convId, seq: m.seq, from: m.from, text: m.text, at: m.at, ...(m.activity?.length ? { toolCalls: m.activity.length } : {}) });
  const roomOf = (id: string) => ctx.convs[id.startsWith("room:") ? id : `room:${id}`];
  const okConv = (c?: Conv) => !!c && !c.members.some(denied) && !(c.kind === "dm" && c.id.slice(3).split("+").some(denied));

  async function handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
    const ip = req.socket.remoteAddress ?? "?", t0 = Date.now();
    const out = (code: number, body: unknown, client = "-") => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body));
      try { appendFileSync(AUDIT_FILE, `${new Date().toISOString()} ${ip} ${client} ${req.method} ${(req.url ?? "").split("?")[0]} ${code} ${Date.now() - t0}ms\n`, { mode: 0o600 }); } catch { /* best effort */ }
    };
    const f = failures.get(ip);
    if (f && f.until > Date.now()) return out(429, { error: "too many failed attempts, try later" });
    const auth = req.headers.authorization ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!timingSafeEqual(digest(given), want)) {
      const n = (f && f.until === 0 ? f.n : 0) + 1; failures.set(ip, { n, until: n >= 10 ? Date.now() + 60_000 : 0 });
      await sleep(300); return out(401, { error: "unauthorized" });
    }
    failures.delete(ip);
    let client = String(req.headers["x-orcie-client"] ?? "api").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 20) || "api";
    const bridge = ctx.isExternal(client); // acting as an external agent (e.g. muse): inbox + replies + status
    if ((ctx.agents[client] && !bridge) || client === "user" || client === "system") return out(400, { error: "invalid X-Orcie-Client" }, client);
    if (bridge) ctx.touch(client);

    const u = new URL(req.url ?? "/", "http://x"), path = u.pathname.replace(/\/+$/, "") || "/";
    let raw = ""; for await (const c of req) { raw += c; if (raw.length > 65536) return out(413, { error: "body too large" }, client); }
    let body: any = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { return out(400, { error: "invalid JSON" }, client); }
    let m: RegExpMatchArray | null;
    const num = (k: string, d: number, max: number) => Math.min(Math.max(Number(u.searchParams.get(k) ?? d) || d, 0), max);

    if (req.method === "GET" && (path === "/api/auth" || path === "/api/v1/auth"))
      return out(200, { api: "ok", client, ...(bridge ? { identity: { agent: client, kind: "external" } } : {}), agentAuth: ctx.authMode() }, client); // agentAuth: how agent containers authenticate to Claude (token | host-login-copy | none)
    if (req.method === "GET" && path === "/api/v1/agents")
      return out(200, { agents: Object.values(ctx.agents).filter((a) => !denied(a.name)).map((a) => { const st = ctx.status(a.name); return { name: a.name, kind: st.kind, model: a.model, role: a.profile?.role ?? null, busy: ctx.busy(`dm:${a.name}`), conversation: `dm:${a.name}`, ...(st.kind === "external" ? { online: st.online, lastSeen: st.lastSeen, lastReply: st.lastReply, waiting: st.waiting } : {}) }; }) }, client);
    if (req.method === "GET" && path === "/api/v1/rooms")
      return out(200, { rooms: Object.values(ctx.convs).filter((c) => c.kind === "room" && okConv(c)).map((c) => ({ id: c.id, title: c.title, members: c.members, mode: c.mode ?? "parallel", messages: c.messages.length, busy: ctx.busy(c.id), last: c.messages.at(-1) ? view(c.id, c.messages.at(-1)!) : null })) }, client);

    // read messages: GET /api/v1/agents/:name/messages | /api/v1/rooms/:id/messages  ?after=<seq>&limit=<n>
    if (req.method === "GET" && ((m = path.match(/^\/api\/v1\/agents\/([^/]+)\/messages$/)) || (m = path.match(/^\/api\/v1\/rooms\/([^/]+)\/messages$/)))) {
      const c = path.includes("/agents/") ? ctx.convs[`dm:${decodeURIComponent(m[1])}`] : roomOf(decodeURIComponent(m[1]));
      if (!okConv(c)) return out(404, { error: "not found" }, client);
      const after = num("after", 0, 1e9), limit = num("limit", 50, 200) || 50;
      return out(200, { conversation: c!.id, messages: c!.messages.filter((x) => x.seq > after).slice(-limit).map((x) => view(c!.id, x)), busy: ctx.busy(c!.id) }, client);
    }
    // send: POST .../messages {text, wait?, timeout?}; wait=true holds until the agents have finished replying (or timeout)
    if (req.method === "POST" && ((m = path.match(/^\/api\/v1\/agents\/([^/]+)\/messages$/)) || (m = path.match(/^\/api\/v1\/rooms\/([^/]+)\/messages$/)))) {
      const isAgent = path.includes("/agents/"), name = decodeURIComponent(m[1]);
      const c = isAgent ? ctx.convs[`dm:${name}`] : roomOf(name);
      if (!okConv(c) || (isAgent && !ctx.agents[name])) return out(404, { error: "not found" }, client);
      const text = String(body.text ?? "").trim(); if (!text) return out(400, { error: "text required" }, client); if (text.length > 20000) return out(413, { error: "text too long" }, client);
      const sent = ctx.post(c!, client, text); ctx.route(c!, sent);
      let settled: boolean | undefined;
      if (body.wait) {
        const limit = Math.min(Math.max(Number(body.timeout ?? 120), 5), 600) * 1000, start = Date.now(); let quiet = 0; settled = false;
        while (Date.now() - start < limit) { if (!ctx.busy(c!.id)) { quiet ||= Date.now(); if (Date.now() - quiet > 1500) { settled = true; break; } } else quiet = 0; await sleep(400); }
      }
      return out(settled === undefined ? 202 : 200, { sent: view(c!.id, sent), ...(settled === undefined ? {} : { settled, replies: c!.messages.filter((x) => x.seq > sent.seq && x.from !== "system").map((x) => view(c!.id, x)) }) }, client);
    }
    // ---- bridge (external agent) endpoints: only for a client acting as an external agent, e.g. X-Orcie-Client: muse ----
    if (path === "/api/v1/inbox" || path === "/api/v1/inbox/ack" || path === "/api/v1/inbox/reply" || path === "/api/v1/inbox/working") {
      if (!bridge) return out(403, { error: "inbox is only for external agents (send X-Orcie-Client: <external agent name>)" }, client);
      const visible = () => ctx.inbox(client).filter((i) => okConv(ctx.convs[i.conversation]));
      if (req.method === "GET" && path === "/api/v1/inbox") { // long-poll: ?wait=<seconds, max 30>
        const until = Date.now() + num("wait", 0, 30) * 1000; let items = visible(), lastTouch = Date.now();
        while (!items.length && Date.now() < until) { await sleep(500); if (Date.now() - lastTouch > 5000) { ctx.touch(client); lastTouch = Date.now(); } items = visible(); }
        return out(200, { agent: client, conversations: items }, client);
      }
      const conv = String(body.conversation ?? ""), c = ctx.convs[conv];
      if (!okConv(c)) return out(404, { error: "no such conversation" }, client);
      if (req.method === "POST" && path === "/api/v1/inbox/working") { ctx.working(client, conv, body.on !== false); return out(200, { ok: true }, client); }
      if (req.method === "POST" && path === "/api/v1/inbox/ack") { ctx.ack(client, conv, Number(body.upto ?? c!.messages.at(-1)?.seq ?? 0)); return out(200, { ok: true }, client); }
      if (req.method === "POST" && path === "/api/v1/inbox/reply") {
        const text = String(body.text ?? "").trim(); if (!text) return out(400, { error: "text required" }, client); if (text.length > 20000) return out(413, { error: "text too long" }, client);
        try { return out(200, { posted: view(conv, ctx.reply(client, conv, text, body.upto == null ? undefined : Number(body.upto))) }, client); }
        catch (e: any) { return out(400, { error: e.message }, client); }
      }
    }
    return out(404, { error: "not found" }, client);
  }

  // Bind only to an explicit loopback/Tailscale address; retry while Tailscale is not up yet.
  const host = () => process.env.ORCIE_API_HOST ?? tailscaleIp();
  function tryStart(): boolean {
    if (server) return true;
    const h = host();
    if (!h) return false;
    if (!allowedHost(h)) { console.error(`private API: refusing to bind ${h} (only loopback or Tailscale addresses are allowed)`); return false; }
    server = createServer((req, res) => { handle(req, res).catch((e) => { try { res.writeHead(500).end(JSON.stringify({ error: "internal error" })); } catch { /* closed */ } console.error("private API error:", e?.message); }); });
    server.on("error", (e) => { console.error("private API listen error:", e.message); server = null; });
    server.listen(PORT, h, () => console.log(`private API on http://${h}:${PORT} (token: ${TOKEN_FILE})`));
    return true;
  }
  if (!tryStart()) {
    console.log("private API disabled for now: Tailscale has no address (log in to Tailscale, or set ORCIE_API_HOST=127.0.0.1 to test locally). Retrying every 30s.");
    const iv = setInterval(() => { if (tryStart()) clearInterval(iv); }, 30_000); iv.unref();
  }
}
