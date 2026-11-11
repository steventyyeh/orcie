// Who a room message is for, and what counts as silence (ported from Orca's portal/rooms.py and agent_bridge.py).
//  asked:     agents expected to respond. From the human, any mention of a name counts; from agents only `@name` or a
//             leading vocative ("name, ..." / "name: ..." at the start of a line).
//  mentioned: agents named in passing (not asked anything).
//  broadcast: @here / @all / "everyone" / "each of you" ... (everyone is asked).
const BROADCAST = /(?<![\w-])@(here|channel|all|everyone|team)\b|\b(everyone|all of you|each of you|both of you|you all|y'all)\b/i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type Addressing = { asked: string[]; mentioned: string[]; broadcast: boolean };
export function addressed(text: string, members: string[], fromHuman: boolean): Addressing {
  text = text ?? "";
  if (BROADCAST.test(text)) return { asked: [...members], mentioned: [], broadcast: true };
  const asked: string[] = [], mentioned: string[] = [];
  for (const m of members) {
    const n = esc(m);
    if (!new RegExp(`(?<![\\w-])@?${n}(?![\\w-])`, "i").test(text)) continue;
    const explicit = new RegExp(`(?<![\\w-])@${n}(?![\\w-])`, "i").test(text) || new RegExp(`^\\s*${n}\\s*[,:]`, "im").test(text);
    (fromHuman || explicit ? asked : mentioned).push(m);
  }
  return { asked, mentioned, broadcast: false };
}

/** Anyone woken by a room message: the human talking to nobody in particular is heard by everyone; otherwise only those named. */
export function wakeTargets(a: Addressing, others: string[], fromHuman: boolean): string[] {
  if (fromHuman && !a.asked.length && !a.broadcast) return others;
  return [...new Set([...a.asked, ...a.mentioned])].filter((n) => others.includes(n));
}

// A reply that merely contains NO_REPLY is silence, even when the agent explains itself ("I was not addressed... NO_REPLY").
export const isSilent = (t: string) => /(?<![A-Za-z_])NO_REPLY(?![A-Za-z_])/.test(t ?? "");
// Pure acknowledgements add nothing in a group room.
const ACK = /^\W*(thanks?( you)?|thx|ty|got it|noted|ack(nowledged)?|ok(ay)?|sounds good|great|perfect|agreed|will do|on it|\+1|understood|sure|cool|nice)([ ,.!-]+(team|all|everyone|@?[\w-]+))?\W*$/i;
export const isAck = (t: string) => ACK.test(t ?? "");

/** Agent messages in a row without the human before fan-out pauses. */
export const STREAK_LIMIT = { room: 12, pair: 10, dm: 25 } as const;
export const streakKind = (c: { kind: string; id: string }): keyof typeof STREAK_LIMIT => (c.kind === "room" ? "room" : c.id.includes("+") ? "pair" : "dm");
