import test from "node:test";
import assert from "node:assert/strict";
import { limits, parseSize, validateRes, plan, usageLevel, PRESETS } from "../src/resources.ts";

const b = limits(4, 7923, 39), cur = { cpus: 2, memoryMb: 4096, diskGb: 20 };
test("bounds follow the host: cores, VM memory (capped at 32 GB), VM disk", () => {
  assert.equal(b.cpusMax, 4); assert.equal(b.cpusMin, 0.5); assert.equal(b.memMaxMb, 7923); assert.equal(b.diskMaxGb, 39);
  assert.equal(limits(16, 99999, 2000).memMaxMb, 32768); assert.equal(limits(16, 99999, 2000).diskMaxGb, 500);
});
test("sizes parse with units and reject junk", () => {
  assert.equal(parseSize("4g", "mb"), 4096); assert.equal(parseSize("512m", "mb"), 512); assert.equal(parseSize("20", "gb"), 20); assert.equal(parseSize("20GB", "gb"), 20); assert.equal(parseSize("1536m", "gb"), 1.5);
  for (const bad of ["", "abc", "-4g", "4 x", "1e3g", "$(id)"]) assert.throws(() => parseSize(bad, "mb"), /cannot read size/);
});
test("validateRes: any value inside the bounds, missing fields keep the current value", () => {
  assert.deepEqual(validateRes({ cpus: 1.5 }, cur, b).res, { cpus: 1.5, memoryMb: 4096, diskGb: 20 });
  assert.deepEqual(validateRes({ memoryMb: 3072, diskGb: 33 }, cur, b).res, { cpus: 2, memoryMb: 3072, diskGb: 33 });
  assert.deepEqual(validateRes({}, cur, b).res, cur);
});
test("validateRes rejects out-of-range and non-numeric values", () => {
  assert.throws(() => validateRes({ cpus: 0.25 }, cur, b), /CPU must be between/); assert.throws(() => validateRes({ cpus: 5 }, cur, b), /CPU must be between/);
  assert.throws(() => validateRes({ memoryMb: 512 }, cur, b), /memory must be between/); assert.throws(() => validateRes({ memoryMb: 9000 }, cur, b), /memory must be between/);
  assert.throws(() => validateRes({ diskGb: 1 }, cur, b), /disk must be between/); assert.throws(() => validateRes({ diskGb: 400 }, cur, b), /disk must be between/);
  assert.throws(() => validateRes({ cpus: "lots" }, cur, b), /must be a number/); assert.throws(() => validateRes({ memoryMb: NaN }, cur, b), /must be a number/);
});
test("memory under 2 GB warns when the agent has a browser", () => {
  assert.equal(validateRes({ memoryMb: 1024 }, cur, b, true).warnings.length, 1); assert.equal(validateRes({ memoryMb: 1024 }, cur, b, false).warnings.length, 0); assert.equal(validateRes({ memoryMb: 2048 }, cur, b).warnings.length, 0);
});
test("plan: cpu, memory and disk growth are live; shrinking and the first disk limit restart", () => {
  assert.deepEqual(plan(cur, { ...cur, cpus: 1, memoryMb: 8192 }, 1e9), { live: ["cpu", "memory"], restart: [] });
  assert.deepEqual(plan(cur, { ...cur, diskGb: 30 }, 1e9).live, ["disk"]);
  assert.equal(plan(cur, { ...cur, diskGb: 10 }, 1e9).restart.length, 1);
  assert.equal(plan({ ...cur, diskGb: null }, { ...cur, diskGb: 20 }, 1e9).restart.length, 1);
  assert.deepEqual(plan(cur, cur, 1e9), { live: [], restart: [] });
});
test("plan refuses a shrink that would leave the disk over 85% full", () => {
  const r = plan(cur, { ...cur, diskGb: 10 }, 9 * 2 ** 30); assert.match(r.error ?? "", /at least 11 GB/);
  assert.equal(plan(cur, { ...cur, diskGb: 10 }, 8 * 2 ** 30).error, undefined);
});
test("usage levels: warn at 80%, 95%, full at 100%", () => {
  assert.deepEqual([0.5, 0.8, 0.9, 0.95, 0.99, 1].map((f) => usageLevel(f * 100, 100)), [0, 80, 80, 95, 95, 100]); assert.equal(usageLevel(5, 0), 0);
});
test("presets are quick picks inside the default bounds", () => { for (const p of Object.values(PRESETS)) assert.doesNotThrow(() => validateRes(p, cur, limits(4, 8192, 100))); });
