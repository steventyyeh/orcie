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

// ---- P5: HR profile, promises, files, lay off, fleet endpoints
const json = (path: string, method: string, body?: unknown) => ui(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
test("profile: HR fields are editable after hiring; unknown manager and reporting loops are refused", async () => {
  await uiPost("/agents/external", { name: "pat" }); await uiPost("/agents/external", { name: "quin" });
  const ok = await json("/api/agents/pat/profile", "POST", { profile: { role: "Reviewer", team: "Platform", description: "Reviews PRs", responsibilities: "review\nmerge", manager: "quin" } });
  assert.equal(ok.status, 200); const b = await ok.json() as any; assert.equal(b.profile.team, "Platform"); assert.deepEqual(b.profile.responsibilities, ["review", "merge"]);
  const st = await (await ui("/api/state")).json() as any; assert.equal(st.agents.find((a: any) => a.name === "pat").profile.manager, "quin");
  assert.equal((await json("/api/agents/pat/profile", "POST", { profile: { manager: "ghost" } })).status, 400);
  assert.equal((await json("/api/agents/quin/profile", "POST", { profile: { manager: "pat" } })).status, 400); // quin -> pat -> quin
  assert.equal((await json("/api/agents/pat/profile", "POST", { profile: { manager: "pat" } })).status, 400);
  assert.equal((await json("/api/agents/ghost/profile", "POST", { profile: {} })).status, 404);
});
test("promises: agents add, list and close their own; the human can close; others cannot touch them", async () => {
  const add = await agentCall("pat", "/promises/add", { text: "ship the release notes" }); assert.match(add.body.text, /recorded/);
  assert.match((await agentCall("pat", "/promises/list", {})).body.text, /ship the release notes/);
  const id = Number(/#(\d+)/.exec(add.body.text)![1]);
  assert.equal((await agentCall("quin", "/promises/update", { id, status: "done" })).status, 404); // not quin's promise
  assert.equal((await agentCall("pat", "/promises/update", { id, status: "nonsense" })).status, 400);
  assert.match((await agentCall("pat", "/promises/update", { id, status: "done", note: "sent" })).body.text, /done/);
  assert.match((await agentCall("pat", "/promises/list", {})).body.text, /no promises/); // only active ones by default
  assert.match((await agentCall("pat", "/promises/list", { status: "all" })).body.text, /\[done\].*sent/);
  assert.equal((await json(`/api/promises/${id}`, "POST", { status: "active" })).status, 200); // the human reopens it
  const list = await (await ui("/api/promises?agent=pat&status=active")).json() as any; assert.equal(list.promises.length, 1);
  assert.equal((await json("/api/promises/999999", "POST", { status: "done" })).status, 404);
});
test("files: upload, attach, download; downloads are never rendered as active content; agents only read files from their conversations", async () => {
  const data = Buffer.from("hello file").toString("base64");
  const up = await uiPost("/api/files", { name: "../../notes.txt", data }); assert.ok(/^[0-9a-f]{24}$/.test(up.id)); assert.ok(!up.name.includes("/")); assert.equal(up.size, 10);
  assert.equal((await json("/api/files", "POST", { name: "x", data: "" })).status, 400);
  const dl = await ui(`/api/files/${up.id}`); assert.equal(dl.status, 200); assert.equal(dl.headers.get("content-type"), "application/octet-stream"); assert.match(dl.headers.get("content-disposition")!, /^attachment/); assert.equal(dl.headers.get("x-content-type-options"), "nosniff"); assert.equal(await dl.text(), "hello file");
  const html = await uiPost("/api/files", { name: "page.html", data: Buffer.from("<script>1</script>").toString("base64") });
  const h = await ui(`/api/files/${html.id}?inline=1`); assert.equal(h.headers.get("content-type"), "application/octet-stream"); // inline is only for known image types
  const png = await uiPost("/api/files", { name: "a.png", data: Buffer.from("x").toString("base64") }); assert.equal((await ui(`/api/files/${png.id}?inline=1`)).headers.get("content-type"), "image/png");
  assert.equal((await ui("/api/files/zzzz")).status, 404); assert.equal((await ui("/api/files/" + "0".repeat(24))).status, 404);
  const room = await uiPost("/api/rooms", { title: "files-room", members: ["pat"], mode: "parallel" });
  const msg = await uiPost(`/api/conversations/${encodeURIComponent(room.id)}/messages`, { text: "see attached", files: [up.id, "bogus"] }); assert.deepEqual(msg.files.map((f: any) => f.id), [up.id]);
  assert.equal((await agentCall("pat", "/files/get", { id: up.id })).body.name, "notes.txt"); // pat is in that room
  assert.equal((await agentCall("quin", "/files/get", { id: up.id })).status, 404);          // quin is not
  const shared = await agentCall("pat", "/files/upload", { name: "report.md", data: Buffer.from("# r").toString("base64"), caption: "here" }, { "x-orcie-conversation": room.id }); assert.match(shared.body.text, /shared report.md/);
  const last = (await conv(room.id)).messages.at(-1); assert.equal(last.from, "pat"); assert.equal(last.files[0].name, "report.md");
  assert.equal((await agentCall("pat", "/files/upload", { name: "x", data: "eA==" })).status, 400); // no conversation context
});
test("lay off: needs the name as confirmation, removes the agent from rooms, keeps the history", async () => {
  await uiPost("/agents/external", { name: "rex" });
  const room = await uiPost("/api/rooms", { title: "layoff", members: ["rex", "pat"], mode: "parallel" });
  await uiPost(`/api/conversations/${encodeURIComponent(room.id)}/messages`, { text: "rex remember this" });
  assert.equal((await ui("/api/agents/rex", { method: "DELETE", headers: { "content-type": "application/json" } })).status, 400);
  assert.equal((await ui("/api/agents/rex?confirm=pat", { method: "DELETE", headers: { "content-type": "application/json" } })).status, 400);
  assert.equal((await ui("/api/agents/rex?confirm=rex", { method: "DELETE", headers: { "content-type": "application/json" } })).status, 200);
  const st = await (await ui("/api/state")).json() as any; assert.ok(!st.agents.some((a: any) => a.name === "rex"));
  const c = await conv(room.id); assert.deepEqual(c.members, ["pat"]); assert.ok(c.messages.some((m: any) => m.text === "rex remember this")); assert.ok(c.messages.some((m: any) => /rex was removed/.test(m.text)));
  assert.equal((await conv("dm:rex")).id, "dm:rex"); // the DM history is kept
  assert.equal((await agentCall("rex", "/memory/recall", { query: "x" })).status, 401); // its token no longer works
});
test("fleet endpoints: activity, stats and check answer without Docker agents", async () => {
  assert.deepEqual(((await (await ui("/api/activity")).json()) as any).busy, []);
  const stats = await (await ui("/api/stats")).json() as any; assert.ok(stats.agents.some((a: any) => a.name === "pat" && a.kind === "external"));
  assert.deepEqual(((await (await ui("/api/check")).json()) as any).agents, []); // only container agents are checked
});

// ---- stateful conversation URLs: the page is served at /dm/<agent>, /room/<name>, /dm/<a>+<b>; API routes are unaffected
test("conversation paths serve the page (GET only); the API and the request guard are unaffected", async () => {
  for (const p of ["/dm/alice", "/room/design", "/dm/alice+bob", "/room/some%20room", "/dm/nobody-here"]) {
    const r = await ui(p); assert.equal(r.status, 200, p); assert.match(r.headers.get("content-type")!, /text\/html/); assert.match(await r.text(), /<title>/);
  }
  assert.equal((await ui("/dm/a/b")).status, 404); assert.equal((await ui("/room/")).status, 404); assert.equal((await ui("/rooms/x")).status, 404);
  const post = await ui("/dm/alice", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); assert.notEqual(post.status, 200); // POST /dm/<x> is not the page
  assert.equal((await ui("/dm/alice", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=b" })).status, 415); // the guard still applies
  assert.equal((await ui("/api/state")).headers.get("content-type"), "application/json"); // the API is still JSON
  assert.equal(await withHost("evil.example"), 403); // wrong Host is still refused (fetch cannot override Host, so withHost uses http.request)
});
