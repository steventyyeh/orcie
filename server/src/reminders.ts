// Reminders: an agent books a follow-up with remind_me(when, note) and the portal wakes it in the same conversation when due.
// Pure helpers (parsing, wording, "still running" detection) live here so they can be tested without a server.
export const MIN_MS = 60_000, MAX_MS = 14 * 86_400_000, AUTO_MS = 15 * 60_000;
export const fmtUtc = (d: Date | string) => new Date(d).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** "20m", "2h", "1d" (a delay) or an exact UTC time like 2026-11-17T14:10Z. Returns the due time; throws when unreadable or outside 1 minute to 14 days. */
export function parseWhen(when: unknown, now = Date.now()): Date {
  const s = String(when ?? "").trim();
  if (!s) throw new Error('when is required (a delay like "20m", "2h", "1d", or a UTC time like 2026-11-17T14:10Z)');
  let ms: number;
  const m = s.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/);
  if (m) ms = Number(m[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 } as Record<string, number>)[m[2][0]];
  else {
    const iso = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s.replace(" ", "T")}Z` : s.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, "$1T$2"); // no zone means UTC
    const t = Date.parse(iso);
    if (!Number.isFinite(t) || !/^\d{4}-\d{2}-\d{2}T/.test(iso)) throw new Error(`cannot read when "${s}" (use a delay like 20m, 2h, 1d, or a UTC time like 2026-11-17T14:10Z)`);
    ms = t - now;
  }
  if (!(ms >= MIN_MS - 1000)) throw new Error("a reminder must be at least 1 minute ahead");
  if (ms > MAX_MS + 1000) throw new Error("a reminder can be at most 14 days ahead");
  return new Date(now + Math.round(ms));
}

/** Does this reply say that work is still running / that the agent will check back? Used to book an automatic follow-up.
 *  Deliberately narrow: only first-person statements in the closing part of the reply count, never quoted text (an email being drafted,
 *  a blockquote, a code block), and "I'll follow up with you" about a person does not count; it must be about work that is still going. */
export const STILL_RUNNING = /\b(i'?ll|i will)\s+(check|come)\s+back\b|\bcheck(ing)?\s+back\s+(in|later|on|once|after|when)\b|\b(i'?ll|i will)\s+(report|get)\s+back\s+(once|when|after)\b|\bonce\s+(the|it|that|this|they)\s+(\w+\s+){0,2}(build|deploy(ment)?|job|run|tests?|migration|upload|download|process|install|sync|import)\w*\s+(finish(es|ed)?|complete[sd]?|is done|are done|ends?)\b|\b(build|deploy(ment)?|job|run|tests?|migration|upload|download|process|install|sync|import)\w*\s+(is|are)\s+still\s+(running|in progress|going)\b|\bstill\s+(running|building|deploying|processing)\s+in the background\b/i;
const unquoted = (t: string) => t.replace(/```[\s\S]*?```/g, " ").replace(/^\s*>.*$/gm, " ").replace(/"[^"\n]{0,600}"|“[^”\n]{0,600}”|「[^」\n]{0,600}」/g, " ");
export const wantsFollowUp = (reply: string) => STILL_RUNNING.test(unquoted(reply).slice(-600));
