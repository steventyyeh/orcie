import test from "node:test";
import assert from "node:assert/strict";
import { addressed, wakeTargets, isSilent, isAck, streakKind, STREAK_LIMIT } from "../src/addressing.ts";

const M = ["alice", "bob", "kfl-1"];
test("human: any mention of a name asks that agent", () => {
  assert.deepEqual(addressed("alice can you look at this", M, true).asked, ["alice"]);
  assert.deepEqual(addressed("tell kfl-1 and bob", M, true).asked.sort(), ["bob", "kfl-1"]);
  assert.deepEqual(addressed("nothing here", M, true), { asked: [], mentioned: [], broadcast: false });
});
test("agents: only @name or a leading vocative asks; a passing mention does not", () => {
  assert.deepEqual(addressed("@bob please review", M, false).asked, ["bob"]);
  assert.deepEqual(addressed("bob, please review", M, false).asked, ["bob"]);
  assert.deepEqual(addressed("done\nbob: your turn", M, false).asked, ["bob"]);
  const a = addressed("I told alice about it earlier", M, false);
  assert.deepEqual(a.asked, []); assert.deepEqual(a.mentioned, ["alice"]);
});
test("names are matched as whole words (kfl-1 is not kfl-10, bob is not bobcat)", () => {
  assert.deepEqual(addressed("kfl-10 is down", M, true).asked, []);
  assert.deepEqual(addressed("a bobcat", M, true).asked, []);
  assert.deepEqual(addressed("@kfl-1 hi", M, false).asked, ["kfl-1"]);
});
test("broadcast: @here, everyone, each of you", () => {
  for (const t of ["@here status?", "everyone please check in", "each of you pick one", "@all stop", "you all agree?"]) {
    const a = addressed(t, M, false); assert.equal(a.broadcast, true, t); assert.deepEqual(a.asked, M);
  }
});
test("wake: human naming agents wakes only those; unaddressed human message wakes all; agent without names wakes nobody", () => {
  const others = ["alice", "bob"];
  assert.deepEqual(wakeTargets(addressed("alice, hi", others, true), others, true), ["alice"]);
  assert.deepEqual(wakeTargets(addressed("hello team", others, true), others, true).sort(), ["alice", "bob"]);
  assert.deepEqual(wakeTargets(addressed("no names", others, false), others, false), []);
  const passing = addressed("alice mentioned it", others, false); // mentioned agents are woken (quietly) but not asked
  assert.deepEqual(wakeTargets(passing, others, false), ["alice"]);
  assert.deepEqual(wakeTargets(addressed("@here go", others, false), others, false).sort(), ["alice", "bob"]);
});
test("NO_REPLY anywhere counts as silence", () => {
  assert.ok(isSilent("NO_REPLY")); assert.ok(isSilent("I was not addressed, so NO_REPLY")); assert.ok(isSilent("NO_REPLY."));
  assert.ok(!isSilent("a normal reply")); assert.ok(!isSilent("NO_REPLYING")); assert.ok(!isSilent(""));
});
test("acknowledgement-only replies are detected; real content is not", () => {
  for (const t of ["thanks!", "Got it.", "ok", "sounds good, team", "Noted", "+1", "Thank you alice!"]) assert.ok(isAck(t), t);
  for (const t of ["thanks, but the build is failing on main", "ok so here is the plan: first migrate the db", "I disagree"]) assert.ok(!isAck(t), t);
});
test("streak kinds", () => {
  assert.equal(streakKind({ kind: "room", id: "room:x" }), "room"); assert.equal(streakKind({ kind: "dm", id: "dm:a+b" }), "pair"); assert.equal(streakKind({ kind: "dm", id: "dm:a" }), "dm");
  assert.ok(STREAK_LIMIT.pair < STREAK_LIMIT.room);
});
