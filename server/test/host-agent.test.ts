import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
const dir = mkdtempSync(`${tmpdir()}/orcie-ht-`); process.env.ORCIE_DIR = dir; // before any module reads it
const { denyList, NEVER_LINK } = await import("../src/tmux-bridge.ts");

test("secretary and commander can never be linked, whatever ORCIE_TMUX_DENY says", () => {
  assert.deepEqual(denyList("").sort(), [...NEVER_LINK].sort());
  assert.ok(denyList("foo, bar").includes("foo") && denyList("foo").includes("secretary") && denyList("x").includes("commander"));
  assert.ok(!denyList("").includes("orcie-commander"), "the user's one-session opt-in");
  assert.ok(denyList("orcie-commander").includes("orcie-commander"), "can be denied again");
});

test("host tools: own token derived from the secret, mode 600, wrappers never contain the secret", async () => {
  const { installHostTools, TOOLS } = await import("../src/host-tools.ts");
  const { agentToken } = await import("../src/guard.ts");
  const secret = "s3cret-value-for-test", r = installHostTools("box", secret, 8081);
  assert.equal(readFileSync(`${r.dir}/token`, "utf8"), agentToken(secret, "box"));
  assert.equal(statSync(`${r.dir}/token`).mode & 0o777, 0o600);
  for (const t of TOOLS) { assert.ok(existsSync(`${r.bin}/${t}`)); assert.ok(!readFileSync(`${r.bin}/${t}`, "utf8").includes(secret)); }
  assert.ok(r.dir.startsWith(dir), "stays inside the test directory");
  assert.notEqual(agentToken(secret, "box"), secret);
});
