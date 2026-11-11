import test from "node:test";
import assert from "node:assert/strict";
import { cleanProfile, managerError, validName, validModel } from "../src/profile.ts";

test("agent names: lowercase, digits and dashes, starting with a letter", () => {
  for (const n of ["alice", "kfl-1", "a", "bob-the-builder-2"]) assert.ok(validName(n), n);
  for (const n of ["Alice", "1abc", "-x", "a b", "a_b", "../etc", "", "x".repeat(32), undefined, 5, "a;rm -rf /"]) assert.ok(!validName(n as any), String(n));
});
test("model names must look like claude-*", () => {
  assert.ok(validModel("claude-sonnet-5-5")); assert.ok(validModel("claude-opus-5-5"));
  for (const m of ["gpt-4", "claude", "claude-", "claude-$(id)", "claude-a b", "", null]) assert.ok(!validModel(m as any), String(m));
});
test("cleanProfile: defaults, limits and unknown resources", () => {
  const p = cleanProfile({});
  assert.equal(p.role, "Assistant"); assert.equal(p.resources, "standard"); assert.equal(p.tools.browser, true); assert.deepEqual(p.skills, []);
  assert.equal(cleanProfile({ resources: "gigantic" }).resources, "standard"); assert.equal(cleanProfile({ resources: "large" }).resources, "large");
  assert.equal(cleanProfile({ tools: { browser: false } }).tools.browser, false);
  assert.equal(cleanProfile({ role: "x".repeat(500) }).role.length, 80);
  assert.equal(cleanProfile({ skills: Array.from({ length: 20 }, (_, i) => ({ name: `s${i}` })) }).skills.length, 6);
  assert.equal(cleanProfile(null).role, "Assistant");
});
test("cleanProfile: HR fields (team, manager, responsibilities, description)", () => {
  const p = cleanProfile({ team: " Platform ", manager: "lead", description: "Owns CI", responsibilities: "one\n\n two \nthree" });
  assert.equal(p.team, "Platform"); assert.equal(p.manager, "lead"); assert.equal(p.description, "Owns CI"); assert.deepEqual(p.responsibilities, ["one", "two", "three"]);
  assert.deepEqual(cleanProfile({ responsibilities: Array.from({ length: 30 }, (_, i) => `r${i}`) }).responsibilities?.length, 12);
  const empty = cleanProfile({ team: "", manager: "", responsibilities: [] }); assert.ok(!("team" in empty) && !("manager" in empty) && !("responsibilities" in empty));
});
test("manager: must exist, not be self, and must not create a reporting loop", () => {
  const mgr: Record<string, string | undefined> = { b: "a", c: "b" }, exists = (n: string) => ["a", "b", "c", "d"].includes(n), of = (n: string) => mgr[n];
  assert.equal(managerError("d", undefined, of, exists), null); assert.equal(managerError("d", "a", of, exists), null);
  assert.match(managerError("d", "nobody", of, exists)!, /not an existing agent/);
  assert.match(managerError("a", "a", of, exists)!, /own manager/);
  assert.match(managerError("a", "c", of, exists)!, /loop/); // c -> b -> a already, so a cannot report to c
  assert.match(managerError("d", "../x", of, exists)!, /not an existing/);
});
