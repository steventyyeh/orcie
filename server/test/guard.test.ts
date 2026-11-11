import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { guard, loadSecret, agentToken, identify } from "../src/guard.ts";

const P = 8080, ok = { host: "127.0.0.1:8080" };

test("rejects rebound Host (DNS rebinding)", () => {
  assert.equal(guard(P, { method: "GET", host: "evil.example:8080" })?.status, 403);
  assert.equal(guard(P, { method: "GET" })?.status, 403);
  assert.equal(guard(P, { method: "GET", host: "host.docker.internal:8080" })?.status, 403);
  assert.equal(guard(P, { method: "GET", host: "127.0.0.1:9999" })?.status, 403);
});
test("accepts localhost and 127.0.0.1 GETs", () => {
  assert.equal(guard(P, { method: "GET", host: "localhost:8080" }), null);
  assert.equal(guard(P, { method: "GET", ...ok }), null);
});
test("rejects foreign Origin on mutations", () => {
  assert.equal(guard(P, { method: "POST", ...ok, origin: "https://evil.example", contentType: "application/json" })?.status, 403);
  assert.equal(guard(P, { method: "POST", ...ok, origin: "null", contentType: "application/json" })?.status, 403);
});
test("accepts no Origin, or the server's own origin", () => {
  assert.equal(guard(P, { method: "POST", ...ok, contentType: "application/json" }), null);
  assert.equal(guard(P, { method: "POST", ...ok, origin: "http://127.0.0.1:8080", contentType: "application/json; charset=utf-8" }), null);
  assert.equal(guard(P, { method: "DELETE", host: "localhost:8080", origin: "http://localhost:8080", contentType: "application/json" }), null);
});
test("rejects non-JSON mutations (cross-site form posts)", () => {
  assert.equal(guard(P, { method: "POST", ...ok, contentType: "application/x-www-form-urlencoded" })?.status, 415);
  assert.equal(guard(P, { method: "POST", ...ok, contentType: "text/plain" })?.status, 415);
  assert.equal(guard(P, { method: "POST", ...ok })?.status, 415);
});

test("agent identity comes from the token, never from a claimed name", () => {
  const secret = loadSecret(`${mkdtempSync(`${tmpdir()}/orcie-t-`)}/secret`), names = ["alice", "bob"];
  const ta = agentToken(secret, "alice"), tb = agentToken(secret, "bob");
  assert.notEqual(ta, tb);
  assert.equal(identify(secret, names, `Bearer ${ta}`), "alice");
  assert.equal(identify(secret, names, `Bearer ${tb}`), "bob");
  assert.equal(identify(secret, names, undefined), null);
  assert.equal(identify(secret, names, "Bearer nope"), null);
  assert.equal(identify(secret, names, `Bearer ${agentToken(secret, "mallory")}`), null); // unknown agent
  assert.equal(identify("other-secret", names, `Bearer ${ta}`), null);
});
test("secret file is created private and is stable", () => {
  const f = `${mkdtempSync(`${tmpdir()}/orcie-t-`)}/s`;
  const a = loadSecret(f); assert.equal(a, loadSecret(f)); assert.equal(statSync(f).mode & 0o777, 0o600);
});
