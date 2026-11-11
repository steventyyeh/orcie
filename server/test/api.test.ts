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
    ORCIE_SECRET_FILE: `${dir}/secret`, ORCIE_STORE: `${dir}/a.json`, ORCIE_STATE: `${dir}/s.json`, ORCIE_API_PORT: String(AG + 1000) }, stdio: "ignore" });
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
const agentCall = async (as: string, path: string, body: unknown) => {
  const r = await fetch(`http://127.0.0.1:${AG}${path}`, { method: "POST", headers: { authorization: `Bearer ${agentToken(SECRET, as)}`, "content-type": "application/json" }, body: JSON.stringify(body) });
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
