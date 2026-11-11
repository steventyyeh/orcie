import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Journal, Notes, memoryBlock, participants, label, hashNotes, type ConvLike } from "../src/memory.ts";

const M = (from: string, text: string, at: string) => ({ from, text, at });
const room: ConvLike = { id: "room:design", kind: "room", title: "design", members: ["alice", "bob"], messages: [M("user", "Let's pick the database for billing: Postgres or SQLite?", "2026-11-01T10:00:00Z"), M("alice", "I propose Postgres for billing.", "2026-11-01T10:01:00Z")] };
const dmA: ConvLike = { id: "dm:alice", kind: "dm", title: "alice", members: ["alice"], messages: [M("user", "how is the weather", "2026-11-02T09:00:00Z")] };
const pair: ConvLike = { id: "dm:alice+bob", kind: "dm", title: "alice ↔ bob", members: ["bob"], messages: [M("alice", "bob, review the billing schema", "2026-11-02T09:30:00Z"), M("system", "notice", "2026-11-02T09:31:00Z")] };
const convs = [room, dmA, pair];

test("participants and labels", () => {
  assert.deepEqual(participants(room), ["alice", "bob"]);
  assert.deepEqual(participants(dmA), ["alice"]);
  assert.deepEqual(participants(pair), ["alice", "bob"]);
  assert.equal(label(room, "alice"), "#design"); assert.equal(label(dmA, "alice"), "DM with user"); assert.equal(label(pair, "alice"), "DM with bob");
});
test("journal rebuild covers every conversation, includes own replies, skips system notices", () => {
  const j = new Journal(); j.rebuild(convs);
  assert.equal(j.size("alice"), 4); assert.equal(j.size("bob"), 3); assert.equal(j.size("carol"), 0);
  assert.ok(j.all("alice").some((m) => m.from === "alice" && m.conv === "room:design")); // its own reply
  assert.ok(j.all("alice").every((m, i, a) => i === 0 || a[i - 1].at <= m.at)); // time ordered
  assert.ok(!j.all("alice").some((m) => m.text === "notice"));
});
test("onPost appends to every participant; rebuild is equivalent", () => {
  const j = new Journal(); j.rebuild(convs);
  const m = M("bob", "billing schema looks fine", "2026-11-03T08:00:00Z"); pair.messages.push(m); j.onPost(pair, m);
  assert.equal(j.size("alice"), 5); assert.equal(j.size("bob"), 4);
  const k = new Journal(); k.rebuild(convs); assert.deepEqual(k.all("alice"), j.all("alice")); pair.messages.pop();
});
test("related: finds matching messages from OTHER conversations only", () => {
  const j = new Journal(); j.rebuild(convs);
  const hits = j.related("alice", "dm:alice", "what did we decide about the billing database?");
  assert.ok(hits.length >= 2 && hits.every((m) => m.conv !== "dm:alice"));
  assert.ok(hits.some((m) => m.text.includes("Postgres")));
  assert.deepEqual(j.related("alice", "dm:alice", "zzzz qqqq"), []);
  assert.deepEqual(j.related("alice", "dm:alice", "the and of"), []); // stop words only
  assert.deepEqual(j.related("alice", "dm:alice", "billing", { before: "2026-11-01T10:00:30Z" }).map((m) => m.from), ["user"]); // before-cutoff only
});
test("elsewhere: only newer messages from other conversations", () => {
  const j = new Journal(); j.rebuild(convs);
  assert.deepEqual(j.elsewhere("alice", "dm:alice", "2026-11-02T00:00:00Z").map((m) => m.conv), ["dm:alice+bob"]);
  assert.equal(j.elsewhere("alice", "dm:alice", "").length, 3);
});
test("memoryBlock: notes only when new or changed; sections appear when relevant", () => {
  const dir = mkdtempSync(`${tmpdir()}/orcie-mem-`), n = new Notes(dir); n.remember("alice", "User prefers Postgres");
  const j = new Journal(); j.rebuild(convs); const notes = n.read("alice");
  const base = { agent: "alice", conv: dmA, incoming: "billing database?", notes, journal: j };
  const fresh = memoryBlock({ ...base, state: null });
  assert.match(fresh, /Long-term memory/); assert.match(fresh, /MEMORY\.md/); assert.match(fresh, /Possibly related/); assert.match(fresh, /Meanwhile/);
  const seen = memoryBlock({ ...base, state: { at: "2026-11-02T00:00:00Z", hash: hashNotes(notes) } });
  assert.doesNotMatch(seen, /MEMORY\.md/); // unchanged notes are not repeated
  n.remember("alice", "Deadline is Friday");
  assert.match(memoryBlock({ ...base, notes: n.read("alice"), state: { at: "2026-11-02T00:00:00Z", hash: hashNotes(notes) } }), /Deadline is Friday/);
  assert.equal(memoryBlock({ ...base, incoming: "zzz", notes: "", state: { at: "2999-01-01T00:00:00Z", hash: "" } }), "");
});
test("notes: remember/search, empty rejected, stored per agent", () => {
  const n = new Notes(mkdtempSync(`${tmpdir()}/orcie-mem-`));
  assert.throws(() => n.remember("alice", "  "));
  n.remember("alice", "The deploy key rotates monthly\nsecond line"); n.remember("bob", "unrelated");
  assert.equal(n.search("alice", "deploy rotation").length, 1); assert.equal(n.search("alice", "unrelated").length, 0);
  assert.equal(n.read("carol"), "");
});
