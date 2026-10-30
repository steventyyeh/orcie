// Bridge to an existing Claude Code session running in tmux on the host (e.g. one that needs macOS tools such as Xcode).
// Messages are typed into the pane; the reply is scraped from the pane once it goes idle. Only sessions that were
// explicitly linked are ever touched, and the deny list keeps the manager/secretary sessions out.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const DENY = (process.env.ORCIE_TMUX_DENY ?? "orcie-commander,secretary,commander").split(",").map((s) => s.trim()).filter(Boolean);
const DIR = process.env.ORCIE_TMUX_DIR ?? `${process.env.HOME}/.orcie/tmux`;
const tmux = (...a: string[]) => execFileSync("tmux", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

export const sessionAlive = (s: string) => { try { tmux("has-session", "-t", `=${s}`); return true; } catch { return false; } };
export const listSessions = () => { try { return tmux("list-sessions", "-F", "#{session_name}").split("\n").filter(Boolean).filter((s) => !DENY.includes(s)); } catch { return []; } };
export function checkLinkable(s: string) {
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(s ?? "")) throw new Error("invalid tmux session name");
  if (DENY.includes(s)) throw new Error(`session ${s} cannot be linked (deny list)`);
  if (!sessionAlive(s)) throw new Error(`no tmux session named ${s}`);
}

const pane = (s: string) => tmux("capture-pane", "-p", "-J", "-t", `=${s}:`, "-S", "-3000");
const busy = (t: string) => /esc to interrupt/i.test(t.split("\n").slice(-12).join("\n"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Claude Code marks assistant text with a leading "⏺" and tool calls with "⏺ Name(...)"; tool output hangs off "⎿".
const chrome = (l: string) => /^[\s╭╮╰╯│─┌┐└┘├┤]*$/.test(l) || /^\s*[╭╰│]/.test(l) || /\? for shortcuts|bypass permissions|shift\+tab|esc to interrupt|^\s*[>❯]|⏵⏵|^─{10,}/i.test(l);
export function extractReply(text: string, marker: string): string {
  const at = text.lastIndexOf(marker); // everything after our message
  const lines = (at >= 0 ? text.slice(at + marker.length) : text.split("\n").slice(-60).join("\n")).split("\n");
  const out: string[] = []; let inBlock = false;
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, "");
    if (/^\s*⏺/.test(l)) { inBlock = !/^\s*⏺\s+[A-Za-z_][\w-]*\(/.test(l); if (inBlock) out.push(l.replace(/^\s*⏺\s?/, "")); continue; }
    if (/^\s*⎿/.test(l) || chrome(l) || /^\s*✻|^\s*·\s/.test(l)) { if (/^\s*⎿/.test(l)) inBlock = false; continue; }
    if (inBlock) out.push(l.replace(/^ {2}/, ""));
  }
  const s = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return s || lines.filter((l) => !chrome(l)).join("\n").trim().slice(-3000);
}

// The pane has no scrollback (full-screen UI), so long replies cannot be scraped. Claude Code also writes every turn to a
// transcript (~/.claude/projects/<cwd>/<session>.jsonl); that is structured and complete, so it is the primary source.
const PROJECTS = `${process.env.HOME}/.claude/projects`;
const projectDir = (session: string) => { try { return `${PROJECTS}/${tmux("display", "-p", "-t", `=${session}:`, "#{pane_current_path}").trim().replace(/[^A-Za-z0-9]/g, "-")}`; } catch { return ""; } };
const entryText = (j: any) => { const c = j?.message?.content; return typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : ""; };
function fromTranscript(dir: string, marker: string): { text: string; done: boolean } | null {
  if (!dir || !existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => ({ f: `${dir}/${f}`, t: statSync(`${dir}/${f}`).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 4);
  for (const { f } of files) {
    let rows: any[]; try { rows = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { continue; }
    const at = rows.map((j, i) => (j.type === "user" && entryText(j).includes(marker) ? i : -1)).filter((i) => i >= 0).at(-1);
    if (at === undefined) continue;
    const after = rows.slice(at + 1).filter((j) => j.type === "assistant" || (j.type === "user" && Array.isArray(j.message?.content) && j.message.content.some((b: any) => b?.type === "tool_result")));
    const lastResult = after.map((j, i) => (j.type === "user" ? i : -1)).filter((i) => i >= 0).at(-1) ?? -1;
    const final = after.slice(lastResult + 1).filter((j) => j.type === "assistant");
    const text = final.map(entryText).filter(Boolean).join("\n\n").trim();
    const lastA = after.filter((j) => j.type === "assistant").at(-1);
    return { text, done: !!lastA && lastA.message?.stop_reason === "end_turn" };
  }
  return null;
}

const locks = new Map<string, Promise<unknown>>();
export type TmuxTurn = { session: string; from: string; text: string; conv: string; onStatus?: (s: string) => void };
// Types one message into the pane and resolves with the reply text ("" if the session produced nothing).
export function turn(t: TmuxTurn): Promise<string> {
  const run = async () => {
    if (!sessionAlive(t.session)) throw new Error(`tmux session ${t.session} is not running`);
    const id = Date.now().toString(36);
    const marker = `[orcie ${id}]`;
    let body = `${marker} ${t.from} in ${t.conv}: ${t.text}`;
    if (t.text.includes("\n") || body.length > 300) { // large or multi-line input goes by file pointer (pasting long text into a TUI truncates)
      mkdirSync(DIR, { recursive: true, mode: 0o700 });
      const f = `${DIR}/${t.session}-${id}.md`;
      writeFileSync(f, t.text, { mode: 0o600 });
      body = `${marker} Message from ${t.from} (${t.conv}). Read ${f} and reply here in plain text.`;
    }
    tmux("send-keys", "-t", `=${t.session}:`, "-l", body);
    await sleep(400); tmux("send-keys", "-t", `=${t.session}:`, "Enter");
    // wait for the reply to land in the transcript and the session to go idle; fall back to the screen if there is no transcript
    const dir = projectDir(t.session), start = Date.now(); let last = "", still = 0, sawBusy = false;
    while (Date.now() - start < 15 * 60_000) {
      await sleep(1500);
      if (!sessionAlive(t.session)) throw new Error(`tmux session ${t.session} ended`);
      const p = pane(t.session);
      if (busy(p)) { sawBusy = true; still = 0; t.onStatus?.("working"); } else if (p === last) still++; else still = 0;
      last = p;
      const tr = fromTranscript(dir, marker);
      if (tr?.done && still >= 2) return tr.text || "";
      if (!tr && still >= 4 && Date.now() - start > 60_000) return extractReply(p, marker); // no transcript found: best-effort screen scrape
    }
    throw new Error("timed out waiting for the tmux session to finish");
  };
  const prev = locks.get(t.session) ?? Promise.resolve();
  const next = prev.then(run, run); locks.set(t.session, next.catch(() => {}));
  return next as Promise<string>;
}
