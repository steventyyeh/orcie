import test from "node:test";
import assert from "node:assert/strict";
import { parseWhen, wantsFollowUp, fmtUtc } from "../src/reminders.ts";

const now = Date.UTC(2026, 10, 17, 12, 0, 0);
test("delays: minutes, hours, days", () => {
  assert.equal(parseWhen("20m", now).getTime(), now + 20 * 60_000); assert.equal(parseWhen("2h", now).getTime(), now + 2 * 3_600_000); assert.equal(parseWhen("1d", now).getTime(), now + 86_400_000);
  assert.equal(parseWhen("14d", now).getTime(), now + 14 * 86_400_000); assert.equal(parseWhen("1m", now).getTime(), now + 60_000);
});
test("exact UTC time, with or without a zone", () => {
  assert.equal(parseWhen("2026-11-17T14:10Z", now).toISOString(), "2026-11-17T14:10:00.000Z"); assert.equal(parseWhen("2026-11-17T14:10", now).toISOString(), "2026-11-17T14:10:00.000Z");
  assert.equal(parseWhen("2026-11-17 14:10", now).toISOString(), "2026-11-17T14:10:00.000Z");
});
test("outside 1 minute to 14 days, or unreadable, is refused", () => {
  assert.throws(() => parseWhen("30s", now), /cannot read/); assert.throws(() => parseWhen("0m", now), /at least 1 minute/); assert.throws(() => parseWhen("15d", now), /at most 14 days/);
  assert.throws(() => parseWhen("2026-11-17T11:00Z", now), /at least 1 minute/); assert.throws(() => parseWhen("2026-12-30T00:00Z", now), /at most 14 days/);
  for (const bad of ["", "soon", "tomorrow", "-5m", "5 x"]) assert.throws(() => parseWhen(bad, now));
});
test("formats UTC", () => assert.equal(fmtUtc("2026-11-17T14:10:00Z"), "2026-11-17 14:10 UTC"));
test("detects 'still running, I'll check back' replies", () => {
  for (const y of ["The build is still running. I'll check back in 10 minutes.", "Kicked it off; once the build finishes I will report.", "The build is still running in the background.", "Once the deploy finishes I will report.", "The migration is still running."]) assert.ok(wantsFollowUp(y), y);
  for (const n of ["The email says: \"After the meeting, I'll follow up with you to work out the arrangement.\"", "> I will check back later\nHere is the draft.", "Still to send: the short reminder as a separate message.", "**She'll likely be upset, and it would look like you broke a promise.**", "Done. All tests pass.", "Here is the summary of the migration.", "NO_REPLY"]) assert.ok(!wantsFollowUp(n), n);
});
