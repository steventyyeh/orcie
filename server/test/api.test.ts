// End-to-end check of the two listeners against a real server process (no Docker needed: no agents are created).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { agentToken } from "../src/guard.ts";

const dir = mkdtempSync(`${tmpdir()}/orcie-api-`), UI = 18080 + (process.pid % 500), AG = UI + 1000;
const SECRET = "test-secret";
let srv: ChildProcess;
before(async () => {
  writeFileSync(`${dir}/secret`, SECRET);
  srv = spawn("node", ["--experimental-strip-types", "server/src/index.ts"], { env: { ...process.env, HOME: dir, PORT: String(UI), ORCIE_AGENT_PORT: String(AG), ORCIE_DB: `${dir}/t.db`,
    ORCIE_SECRET_FILE: `${dir}/secret`, ORCIE_STORE: `${dir}/a.json`, ORCIE_STATE: `${dir}/s.json`, ORCIE_API_PORT: String(AG + 1000), ORCIE_STREAK_LIMIT: "3" }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${UI}/api/state`); return; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  throw new Error("server did not start");
});
after(() => srv?.kill());

const ui = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(`http://127.0.0.1:${UI}${path}`, init);
const withHost = (host: string) => new Promise<number>((res, rej) => { // fetch() forbids overriding Host, so use http.request
  const r = request({ host: "127.0.0.1", port: UI, path: "/api/state", headers: { host } }, (x) => { x.resume(); res(x.statusCode ?? 0); }); r.on("error", rej); r.end();
});
test("UI API: wrong Host is refused", async () => { assert.equal(await withHost("evil.example"), 403); assert.equal(await withHost(`127.0.0.1:${UI}`), 200); });
test("UI API: normal GET works", async () => { assert.equal((await ui("/api/state")).status, 200); });
test("UI API: cross-origin and form posts are refused", async () => {
  assert.equal((await ui("/rooms", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await ui("/api/rooms", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=b" })).status, 415);
});
test("agent listener: no token / bad token is refused", async () => {
  assert.equal((await fetch(`http://127.0.0.1:${AG}/dm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "alice", to: "bob", text: "hi" }) })).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${AG}/dm`, { method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json" }, body: "{}" })).status, 401);
});
test("agent listener: a token for an agent that does not exist is refused", async () => {
  const r = await fetch(`http://127.0.0.1:${AG}/dm`, { method: "POST", headers: { authorization: `Bearer ${agentToken(SECRET, "ghost")}`, "content-type": "application/json" }, body: JSON.stringify({ to: "bob", text: "hi" }) });
  assert.equal(r.status, 401);
});

// ---- memory tools through the agent listener (an external agent stands in for a container: it has a token but needs no Docker)
const agentCall = async (as: string, path: string, body: unknown, extra: Record<string, string> = {}) => {
  const r = await fetch(`http://127.0.0.1:${AG}${path}`, { method: "POST", headers: { authorization: `Bearer ${agentToken(SECRET, as)}`, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
};
const uiPost = async (path: string, body: unknown) => (await ui(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
test("memory tools: remember, recall and read_room are scoped to the calling agent", async () => {
  await uiPost("/agents/external", { name: "zed" }); await uiPost("/agents/external", { name: "yan" });
  const room = await uiPost("/api/rooms", { title: "plans", members: ["zed"], mode: "parallel" });
  await uiPost(`/api/conversations/${encodeURIComponent(room.id)}/messages`, { text: "We will ship the quasar release on Friday" });
  assert.equal((await agentCall("zed", "/memory/remember", { text: "zed owns the quasar release" })).status, 200);
  assert.equal((await agentCall("zed", "/memory/remember", { text: "   " })).status, 400);
  const rec = await agentCall("zed", "/memory/recall", { query: "quasar" });
  assert.match(rec.body.text, /zed owns the quasar release/); assert.match(rec.body.text, /ship the quasar release/);
  const read = await agentCall("zed", "/rooms/read", { room: "#plans" });
  assert.match(read.body.text, /quasar release on Friday/);
  assert.equal((await agentCall("yan", "/rooms/read", { room: "#plans" })).status, 404); // yan is not in that room
  assert.match((await agentCall("yan", "/memory/recall", { query: "quasar" })).body.text, /nothing found/); // and cannot recall it
});

// ---- room behaviour: addressing, cross-room messaging, loop guard, control
const conv = async (id: string) => (await ui(`/api/conversations/${encodeURIComponent(id)}`)).json() as Promise<any>;
test("addressing is saved on each message (to / mentions)", async () => {
  await uiPost("/agents/external", { name: "kay" }); await uiPost("/agents/external", { name: "lee" });
  const room = await uiPost("/api/rooms", { title: "addr", members: ["kay", "lee"], mode: "parallel" });
  const post = (text: string) => uiPost(`/api/conversations/${encodeURIComponent(room.id)}/messages`, { text });
  assert.deepEqual((await post("kay, please look")).to, ["kay"]);
  assert.deepEqual((await post("@here status")).to, ["@here"]);
  const none = await post("morning all good"); assert.equal(none.to, undefined);
});
test("send_message: to the user, to a #room, and to another agent with the origin remembered", async () => {
  const room = await uiPost("/api/rooms", { title: "origin-room", members: ["kay", "lee"], mode: "parallel" });
  assert.match((await agentCall("kay", "/send_message", { to: "user", text: "hello user" })).body.text, /sent to the user/);
  assert.equal((await conv("dm:kay")).messages.at(-1).from, "kay");
  assert.match((await agentCall("kay", "/send_message", { to: "#origin-room", text: "hello room" })).body.text, /posted to #origin-room/);
  assert.equal((await conv(room.id)).messages.at(-1).text, "hello room");
  assert.equal((await agentCall("kay", "/send_message", { to: "#nowhere", text: "x" })).status, 400);
  assert.equal((await agentCall("kay", "/send_message", { to: "kay", text: "x" })).status, 400);
  const r = await agentCall("kay", "/send_message", { to: "lee", text: "please check the build" }, { "x-orcie-conversation": room.id });
  assert.match(r.body.text, /sent to lee/); assert.match(r.body.text, /#origin-room/);
  const pair = await conv("dm:kay+lee"); assert.equal(pair.origin, room.id); assert.equal(pair.async, true); assert.equal(pair.messages.at(-1).from, "kay");
  const spoof = await agentCall("lee", "/send_message", { to: "kay", text: "hi" }, { "x-orcie-conversation": "dm:nobody-here" }); // an origin the sender is not part of is ignored
  assert.equal(spoof.status, 200); assert.equal((await conv("dm:kay+lee")).origin, room.id);
});
test("loop guard: pauses with a visible notice after N agent messages in a row, resumes when the user posts (rooms and agent DMs)", async () => {
  const room = await uiPost("/api/rooms", { title: "loop", members: ["kay", "lee"], mode: "parallel" });
  const say = (t: string) => agentCall("kay", "/send_message", { to: "#loop", text: t });
  for (const t of ["one", "two", "three"]) assert.match((await say(t)).body.text, /posted/);
  assert.match((await say("four")).body.text, /paused/);
  const msgs = (await conv(room.id)).messages; assert.equal(msgs.filter((m: any) => m.from === "system" && /Paused fan-out/.test(m.text)).length, 1);
  assert.equal(msgs.filter((m: any) => m.from === "kay").length, 3); // the 4th was not posted
  await uiPost(`/api/conversations/${encodeURIComponent(room.id)}/messages`, { text: "carry on" });
  assert.match((await say("five")).body.text, /posted/); // resumed
  // agent<->agent DM: the same guard
  for (const t of ["a", "b", "c"]) await agentCall("kay", "/send_message", { to: "lee", text: t });
  assert.match((await agentCall("kay", "/send_message", { to: "lee", text: "d" })).body.text, /paused/);
  assert.match((await agentCall("kay", "/dm", { to: "lee", text: "e" })).body.reply, /Paused fan-out/); // sync /dm too
  const pair = await conv("dm:kay+lee"); assert.ok(pair.messages.some((m: any) => m.from === "system" && /Paused fan-out/.test(m.text)));
  const posted = await uiPost("/api/conversations/dm:kay%2Blee/messages", { text: "ok continue" }); assert.equal(posted.from, "user"); // the user can post in an agent DM
  assert.match((await agentCall("kay", "/send_message", { to: "lee", text: "f" })).body.text, /sent to lee/);
});
test("control: cancel works for any agent, model change is validated and refused for non-container agents", async () => {
  assert.equal((await ui("/api/agents/kay/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
  assert.equal((await ui("/api/agents/ghost/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
  const m = await ui("/api/agents/kay/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-opus-5-5" }) }); assert.equal(m.status, 400); // external agent
  assert.ok(((await (await ui("/api/models")).json()) as any).models.includes("claude-sonnet-5-5"));
});

test("browser API: unknown agent 404, external agents have no browser, wrong method 405, vnc-ws refuses foreign origins", async () => {
  assert.equal((await ui("/api/agents/ghost/browser/state")).status, 404);
  assert.equal((await ui("/api/agents/kay/browser/state")).status, 400); // external agent
  assert.equal((await ui("/api/agents/kay/browser/take", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
  const ws = (origin?: string) => new Promise<number>((res) => { const r = request({ host: "127.0.0.1", port: UI, path: "/api/agents/kay/browser/vnc-ws", headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", ...(origin ? { origin } : {}) } }, (x) => { x.resume(); res(x.statusCode ?? 0); }); r.on("upgrade", (x, s) => { s.destroy(); res(x.statusCode ?? 0); }); r.on("error", () => res(0)); r.end(); });
  assert.equal(await ws("https://evil.example"), 403); assert.equal(await ws(), 403);
  assert.equal(await ws(`http://127.0.0.1:${UI}`), 404); // allowed origin, but an external agent has no browser
});
test("static noVNC is served, and path traversal is refused", async () => {
  assert.equal((await ui("/novnc/core/rfb.js")).status, 200);
  assert.equal((await ui("/novnc/../../server/src/index.ts")).status, 404);
  assert.equal((await ui("/novnc/%2e%2e/%2e%2e/package.json")).status, 404);
});
