// Automatic long-term memory (ported from Orca's portal/memory.py).
// Short-term memory is one conversation's Claude session. Long-term memory spans every conversation an agent is in:
//  - journal: every message in every conversation the agent takes part in, including its own replies. It is a derived
//    index: rebuilt from stored history at startup and appended to on every post, never written by the agent.
//  - MEMORY.md: notes the agent curates itself with `remember`. Stored on the host, outside the container.
// Each turn the server adds a "Long-term memory" block: the notes (when the session is new or they changed),
// "Possibly related" older messages from the agent's other conversations that match the incoming message, and
// "Meanwhile" messages from its other conversations since this one was last looked at.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

export type JMsg = { at: string; conv: string; label: string; from: string; text: string };
export type ConvLike = { id: string; kind: "dm" | "room"; title: string; members: string[]; messages: { from: string; text: string; at: string }[] };

export const DIGEST_MAX_MSGS = 25, DIGEST_MSG_CHARS = 400, DIGEST_MAX_CHARS = 6000, NOTES_MAX_CHARS = 8000, JOURNAL_TEXT_CHARS = 4000;

/** Agents that take part in a conversation: room members, the agent of dm:<agent>, both sides of dm:a+b. */
export const participants = (c: ConvLike): string[] => (c.kind === "room" ? c.members : c.id.slice(3).split("+")).filter((n) => n !== "user");

export function label(c: ConvLike, me: string): string {
  if (c.kind === "room") return `#${c.title}`;
  const other = c.id.slice(3).split("+").filter((n) => n !== me);
  return other.length && c.id.includes("+") ? `DM with ${other[0]}` : "DM with user";
}

const STOP = new Set(`a an and are as at be been but by can could did do does for from had has have how i if in into is it its just me my no not now of on or our please so that the their them then there these they this to too up us was we were what when where which who why will with would you your yes ok okay again also any all some get got let lets one`.split(/\s+/));
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (let w of text.toLowerCase().replace(/[^a-z0-9_-]+/g, " ").split(" ")) {
    w = w.replace(/^[-_]+|[-_]+$/g, "");
    if (w.length >= 3 && !STOP.has(w)) { out.add(w); if (w.endsWith("s") && w.length > 4) out.add(w.slice(0, -1)); }
  }
  return out;
}

const stamp = (at: string) => at.slice(5, 16).replace("T", " ");
const clip = (t: string) => { const x = t.replace(/\n/g, " "); return x.length > DIGEST_MSG_CHARS ? `${x.slice(0, DIGEST_MSG_CHARS)}…` : x; };
const line = (m: JMsg, me: string) => `  ${stamp(m.at)} ${m.label} [${m.from === me ? "you" : m.from}]: ${clip(m.text)}`;

export class Journal {
  private by = new Map<string, JMsg[]>();
  /** Regenerate every agent's journal from stored conversation history. */
  rebuild(convs: ConvLike[]) {
    this.by.clear();
    for (const c of convs) for (const a of participants(c)) for (const m of c.messages) this.add(a, c, m, false);
    for (const list of this.by.values()) list.sort((x, y) => x.at.localeCompare(y.at));
  }
  add(agent: string, c: ConvLike, m: { from: string; text: string; at: string }, ordered = true) {
    if (m.from === "system") return; // system notices are not memory
    const list = this.by.get(agent) ?? this.by.set(agent, []).get(agent)!;
    list.push({ at: m.at, conv: c.id, label: label(c, agent), from: m.from, text: m.text.slice(0, JOURNAL_TEXT_CHARS) });
    if (ordered && list.length > 1 && list[list.length - 2].at > m.at) list.sort((x, y) => x.at.localeCompare(y.at));
  }
  /** Append a freshly posted message to every participant's journal. */
  onPost(c: ConvLike, m: { from: string; text: string; at: string }) { for (const a of participants(c)) this.add(a, c, m); }
  all(agent: string) { return this.by.get(agent) ?? []; }
  size(agent: string) { return this.all(agent).length; }

  /** Messages from the agent's OTHER conversations that best match `query` (automatic recall). */
  related(agent: string, excludeConv: string | null, query: string, opts: { before?: string; k?: number } = {}): JMsg[] {
    const q = terms(query); if (!q.size) return [];
    let msgs = this.all(agent).filter((m) => m.conv !== excludeConv);
    if (opts.before) msgs = msgs.filter((m) => m.at <= opts.before!); // newer ones belong to the "Meanwhile" digest
    const sets = msgs.map((m) => terms(m.text)), df = new Map<string, number>();
    for (const t of sets) for (const w of t) if (q.has(w)) df.set(w, (df.get(w) ?? 0) + 1);
    const n = msgs.length, scored: { s: number; m: JMsg }[] = [];
    msgs.forEach((m, i) => {
      const hit = [...sets[i]].filter((w) => q.has(w)); if (!hit.length) return;
      let s = hit.reduce((a, w) => a + (1 / (1 + df.get(w)!)) * (1 + Math.sqrt(n / (1 + df.get(w)!))), 0);
      if (m.from === agent) s += 0.15; // what *you* said matters most
      s += 0.0001 * i;                 // recency tiebreak
      scored.push({ s, m });
    });
    return scored.sort((a, b) => b.s - a.s).slice(0, opts.k ?? 8).map((x) => x.m).sort((a, b) => a.at.localeCompare(b.at));
  }
  /** Messages in the agent's OTHER conversations newer than `after` (ISO time). */
  elsewhere(agent: string, excludeConv: string, after: string): JMsg[] { return this.all(agent).filter((m) => m.conv !== excludeConv && m.at > after); }
}

export function relatedBlock(agent: string, hits: JMsg[]): string {
  return hits.length ? `Possibly related, from earlier in your other conversations (found automatically; use recall for more):\n${hits.map((m) => line(m, agent)).join("\n")}` : "";
}
export function meanwhileBlock(agent: string, msgs: JMsg[]): string {
  if (!msgs.length) return "";
  let omitted = Math.max(0, msgs.length - DIGEST_MAX_MSGS);
  const kept: string[] = []; let total = 0;
  for (const m of msgs.slice(-DIGEST_MAX_MSGS).reverse()) { // keep the newest if over budget
    const l = line(m, agent); if (total + l.length > DIGEST_MAX_CHARS) { omitted++; continue; }
    kept.push(l); total += l.length;
  }
  let head = 'Meanwhile in your other conversations (long-term memory; "you" = messages you sent):';
  if (omitted) head += ` ${omitted} earlier message(s) omitted - use recall/read_room for more.`;
  return `${head}\n${kept.reverse().join("\n")}`;
}

/** MEMORY.md notes, kept on the host under <dir>/<agent>/MEMORY.md. */
export class Notes {
  private dir: string;
  constructor(dir: string) { this.dir = dir; }
  private path(agent: string) { return `${this.dir}/${agent}/MEMORY.md`; }
  read(agent: string): string { try { return readFileSync(this.path(agent), "utf8").trim().slice(-NOTES_MAX_CHARS); } catch { return ""; } }
  remember(agent: string, text: string) {
    const t = text.trim().replace(/\r/g, "").slice(0, 2000); if (!t) throw new Error("empty note");
    if (!existsSync(`${this.dir}/${agent}`)) mkdirSync(`${this.dir}/${agent}`, { recursive: true, mode: 0o700 });
    appendFileSync(this.path(agent), `- ${new Date().toISOString().slice(0, 10)}: ${t.replace(/\n+/g, " ")}\n`, { mode: 0o600 });
  }
  search(agent: string, query: string): string[] {
    const q = terms(query); if (!q.size) return [];
    return this.read(agent).split("\n").filter((l) => { const t = terms(l); return [...q].some((w) => t.has(w)); });
  }
}
export const hashNotes = (t: string) => (t ? createHash("sha1").update(t).digest("hex").slice(0, 12) : "");

/** The per-turn block. `state` = what this conversation's session already saw (cursor time, notes hash), or null when new. */
export function memoryBlock(a: { agent: string; conv: ConvLike; incoming: string; notes: string; journal: Journal; state: { at: string; hash: string } | null }): string {
  const parts: string[] = [];
  if (a.notes && (!a.state || a.state.hash !== hashNotes(a.notes))) parts.push(`Your long-term notes (MEMORY.md, shared by all your conversations):\n${a.notes}`);
  const rel = relatedBlock(a.agent, a.journal.related(a.agent, a.conv.id, a.incoming, a.state ? { before: a.state.at } : {}));
  if (rel) parts.push(rel);
  const meanwhile = meanwhileBlock(a.agent, a.journal.elsewhere(a.agent, a.conv.id, a.state?.at ?? ""));
  if (meanwhile) parts.push(meanwhile);
  return parts.length ? `=== Long-term memory (from orcie; not new messages in this conversation) ===\n${parts.join("\n\n")}\n=== end long-term memory ===` : "";
}
