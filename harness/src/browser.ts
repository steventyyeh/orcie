// Live, shareable browser for one agent: Xvfb + headed Chromium (CDP) + x11vnc, all inside the agent container.
// The agent's Playwright MCP connects to Chromium through a small CDP proxy (:9223) that can refuse interaction while the
// human holds control; the human watches/drives the same browser through VNC (relayed by the orcie server, never published).
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { upgrade } from "./ws-lite.ts";

const DISPLAY = ":99", CDP = 9222, PROXY = 9223, PROFILE = "/data/browser-profile";
const enabled = (() => { try { return JSON.parse(Buffer.from(process.env.ORCIE_PROFILE ?? "", "base64").toString() || "{}")?.tools?.browser !== false; } catch { return true; } })() && process.env.ORCIE_BROWSER_LIVE !== "off";

type Control = { holder: "agent" | "human"; since: number; reason: string | null; note: string | null; pending: boolean };
export const control: Control = { holder: "agent", since: Date.now(), reason: null, note: null, pending: false };
const waiters: (() => void)[] = [];
const settle = () => { if (control.holder === "agent" && !control.pending) while (waiters.length) waiters.shift()!(); };

// Methods that act on the page; refused for the agent while the human holds control (reads and screenshots still work).
export const blocked = (method: string) => /^Input\./.test(method) || /^Page\.(navigate|navigateToHistoryEntry|reload|close|handleJavaScriptDialog)$/.test(method) || /^Target\.(createTarget|closeTarget)$/.test(method);

// ---- processes ----
const procs = new Map<string, ChildProcess>();
function supervise(name: string, cmd: string, args: string[], env: Record<string, string> = {}) {
  let delay = 1000;
  const go = () => {
    const p = spawn(cmd, args, { stdio: "ignore", env: { ...process.env, DISPLAY, ...env } }); procs.set(name, p);
    const t = Date.now();
    p.on("exit", () => { delay = Date.now() - t > 20_000 ? 1000 : Math.min(delay * 2, 10_000); setTimeout(go, delay).unref(); });
    p.on("error", () => {});
  };
  go();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function startBrowser() {
  if (!enabled) return;
  try { for (const f of existsSync(PROFILE) ? readdirSync(PROFILE) : []) if (f.startsWith("Singleton")) rmSync(`${PROFILE}/${f}`, { force: true }); } catch { /* fresh profile */ }
  supervise("xvfb", "Xvfb", [DISPLAY, "-screen", "0", "1280x800x24", "-ac", "-noreset"]);
  for (let i = 0; i < 50 && !existsSync("/tmp/.X11-unix/X99"); i++) await sleep(100);
  supervise("x11vnc", "x11vnc", ["-display", DISPLAY, "-forever", "-shared", "-nopw", "-rfbport", "5900", "-localhost", "-quiet"]);
  supervise("chromium", "/usr/local/bin/orcie-chromium", ["--no-sandbox", `--remote-debugging-port=${CDP}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${PROFILE}`, "--window-position=0,0", "--window-size=1280,800",
    "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", "about:blank"]);
  startProxy();
}

// ---- CDP proxy: what the agent's Playwright connects to ----
const fwd = (path: string, method = "GET") => new Promise<{ status: number; body: Buffer; type: string }>((resolve, reject) => {
  const r = httpRequest({ host: "127.0.0.1", port: CDP, path, method }, (x) => { const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => resolve({ status: x.statusCode ?? 502, body: Buffer.concat(c), type: String(x.headers["content-type"] ?? "application/json") })); });
  r.on("error", reject); r.end();
});
function startProxy() {
  const srv = createServer(async (req, res) => {
    try {
      const r = await fwd(req.url ?? "/", req.method);
      res.writeHead(r.status, { "content-type": r.type }); res.end(r.type.includes("json") ? r.body.toString().replace(/127\.0\.0\.1:9222|localhost:9222/g, `127.0.0.1:${PROXY}`) : r.body);
    } catch { res.writeHead(502); res.end(); }
  });
  srv.on("upgrade", (req, sock, head) => {
    const client = upgrade(req, sock, head); if (!client) return;
    const up = new WebSocket(`ws://127.0.0.1:${CDP}${req.url}`); up.binaryType = "arraybuffer";
    const queue: string[] = [];
    up.onopen = () => { for (const q of queue.splice(0)) up.send(q); };
    up.onmessage = (e) => client.send(typeof e.data === "string" ? e.data : Buffer.from(e.data as ArrayBuffer));
    up.onclose = () => client.close(); up.onerror = () => client.close(); client.onClose = () => { try { up.close(); } catch { /* closed */ } };
    client.onMessage = (m) => {
      const text = m.data.toString();
      if (control.holder === "human") { try { const j = JSON.parse(text); if (j && blocked(String(j.method ?? ""))) return void client.send(JSON.stringify({ id: j.id, error: { code: -32000, message: "The human has taken control of this browser. Wait until they hand it back (run browser_help to ask for it)." } })); } catch { /* forward as is */ } }
      up.readyState === 1 ? up.send(text) : queue.push(text);
    };
  });
  srv.listen(PROXY, "127.0.0.1");
}

// ---- control + human endpoints (called by the orcie server; request/wait also by the agent from inside the container) ----
const isLocal = (req: IncomingMessage) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
const tokenOk = (req: IncomingMessage) => { const t = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1], want = process.env.ORCIE_AGENT_TOKEN; return !!t && !!want && t.length === want.length && timingSafeEqual(Buffer.from(t), Buffer.from(want)); };
const run = (cmd: string, args: string[], binary = false) => new Promise<Buffer>((resolve, reject) => execFile(cmd, args, { env: { ...process.env, DISPLAY }, encoding: "buffer", maxBuffer: 30 * 1024 * 1024, timeout: 15000 }, (e, out) => (e ? reject(e) : resolve(out as Buffer))));
async function pageInfo() {
  try { const r = await fwd("/json/list"); const p = (JSON.parse(r.body.toString()) as any[]).find((x) => x.type === "page"); return { running: true, url: p?.url ?? null, title: p?.title ?? null }; } catch { return { running: false, url: null, title: null }; }
}
const view = () => ({ ...control, enabled });

export async function browserHttp(req: IncomingMessage, res: ServerResponse, body: any): Promise<boolean> {
  const url = new URL(req.url ?? "", "http://x"), path = url.pathname;
  if (!path.startsWith("/browser/")) return false;
  const json = (code: number, b: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  const human = tokenOk(req), local = isLocal(req);
  if (!human && !local) return void json(403, { error: "forbidden" }) ?? true;
  if (req.method === "GET" && path === "/browser/state") return void json(200, { ...(await pageInfo()), control: view() }) ?? true;
  if (req.method === "GET" && path === "/browser/control") return void json(200, view()) ?? true;
  if (req.method === "POST" && path === "/browser/control/request") { // the agent asks the human to take over (log in, CAPTCHA, ...)
    control.pending = true; control.reason = String(body.reason ?? "").slice(0, 500) || "help needed"; control.note = null; return void json(200, view()) ?? true;
  }
  if (req.method === "GET" && path === "/browser/control/wait") { // long poll: resolves when the browser is back with the agent
    const ms = Math.min(Number(url.searchParams.get("timeout")) || 900, 3600) * 1000;
    if (control.holder === "agent" && !control.pending) return void json(200, view()) ?? true;
    await new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); waiters.push(() => { clearTimeout(t); resolve(); }); });
    return void json(200, view()) ?? true;
  }
  if (!human) return void json(403, { error: "human-only" }) ?? true; // everything below is the human (via the orcie server)
  if (req.method === "POST" && path === "/browser/control/take") { control.holder = "human"; control.since = Date.now(); control.pending = false; return void json(200, view()) ?? true; }
  if (req.method === "POST" && path === "/browser/control/release") { control.holder = "agent"; control.since = Date.now(); control.pending = false; control.note = String(body.note ?? "").slice(0, 1000) || null; settle(); return void json(200, view()) ?? true; }
  if (req.method === "POST" && path === "/browser/control/cancel") { control.pending = false; control.reason = null; settle(); return void json(200, view()) ?? true; }
  if (req.method === "POST" && path === "/browser/type") { // type into the focused field (OTPs, passwords) without the clipboard
    if (control.holder !== "human") return void json(409, { error: "take control first" }) ?? true;
    const text = String(body.text ?? ""); if (!text || text.length > 10_000) return void json(400, { error: "text required (max 10000 chars)" }) ?? true;
    try { await run("xdotool", ["type", "--clearmodifiers", "--delay", "8", "--", text]); if (body.submit) await run("xdotool", ["key", "Return"]); return void json(200, { ok: true }) ?? true; } catch (e) { return void json(500, { error: String(e).slice(0, 200) }) ?? true; }
  }
  if (req.method === "GET" && path === "/browser/screenshot") {
    try { const png = await run("import", ["-window", "root", "png:-"]); res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }); res.end(png); } catch { json(503, { error: "no display" }); }
    return true;
  }
  if (req.method === "POST" && path === "/browser/restart") { // close pages and restart Chromium; control returns to the agent
    control.holder = "agent"; control.pending = false; control.reason = control.note = null; settle(); procs.get("chromium")?.kill("SIGTERM"); return void json(200, { restarted: true }) ?? true;
  }
  json(404, { error: "not found" }); return true;
}
