import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { roleHeader, migrateMemoryInstructions } from "../../harness/src/role.ts";

const OLD = `# You are agent "bob"
Long-term memory: keep durable notes as files in /data/memory (read /data/memory/INDEX.md at the start of each conversation; update it when you learn something worth keeping).
You have a headless browser via the playwright MCP tools.
To message another agent: orcie-dm <agent-name> "message" (prints their reply).
In chat rooms and DMs you only see what is sent to you in that conversation, so after taking part in a room or any conversation, record what you said and decided in /data/memory (e.g. /data/memory/rooms-<name>.md and a line in INDEX.md). Then later you will know.
Each message starts with "[message from <sender>]".

<!-- orcie-memory -->
## Long-term memory
Use remember.
`;
test("old agents are migrated off /data/memory, nothing else changes, and it is idempotent", () => {
  const f = `${mkdtempSync(`${tmpdir()}/orcie-role-`)}/CLAUDE.md`; writeFileSync(f, OLD);
  migrateMemoryInstructions(f); const once = readFileSync(f, "utf8");
  assert.ok(!once.includes("/data/memory")); assert.match(once, /remember tool/); assert.match(once, /Do not keep notes in files/);
  assert.ok(once.includes("You have a headless browser") && once.includes("<!-- orcie-memory -->") && once.includes('# You are agent "bob"'));
  assert.equal(once.split("\n").length, OLD.split("\n").length); // two lines replaced in place
  migrateMemoryInstructions(f); assert.equal(readFileSync(f, "utf8"), once);
});
test("migrating a missing file or one without the old text is a no-op", () => {
  migrateMemoryInstructions("/nonexistent/CLAUDE.md");
  const f = `${mkdtempSync(`${tmpdir()}/orcie-role-`)}/CLAUDE.md`; writeFileSync(f, "# hello\n"); migrateMemoryInstructions(f); assert.equal(readFileSync(f, "utf8"), "# hello\n");
});
test("role header carries HR fields and the onboarding memory seed, not a /data/memory file", () => {
  const h = roleHeader({ role: "QA", summary: "Tests", team: "Platform", manager: "lead", responsibilities: ["run tests"], systemPrompt: "Be careful.", memorySeed: "The staging URL is x." });
  assert.match(h, /# Role: QA/); assert.match(h, /Team: Platform/); assert.match(h, /Reports to: lead/); assert.match(h, /- run tests/); assert.match(h, /Always remember:\nThe staging URL is x\./); assert.ok(!h.includes("/data/memory"));
});
