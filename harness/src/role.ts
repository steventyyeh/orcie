import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Writes an agent's role (from its HR profile) onto its volume: the header of CLAUDE.md, skills and the memory seed.
// Used on first start and again whenever the profile is edited after hiring.
const slug = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "skill";
const BASE_START = '# You are agent "'; // the entrypoint's base CLAUDE.md always starts with this

export function roleHeader(prof: any): string {
  const hr = [prof.team ? `Team: ${prof.team}` : "", prof.manager ? `Reports to: ${prof.manager}` : "", prof.description ? `About this role: ${prof.description}` : ""].filter(Boolean).join("\n");
  const resp = Array.isArray(prof.responsibilities) && prof.responsibilities.length ? `Responsibilities:\n${prof.responsibilities.map((r: string) => `- ${r}`).join("\n")}` : "";
  const seed = prof.memorySeed ? `Always remember:\n${prof.memorySeed}` : ""; // context from onboarding; durable notes live in orcie memory (remember/recall), not in files
  return [`# Role: ${prof.role}`, prof.summary ?? "", hr, resp, prof.systemPrompt ?? "", seed].filter(Boolean).join("\n\n") + "\n\n---\n\n";
}

export function applyRole(prof: any, home: string) {
  const file = "/data/workspace/CLAUDE.md";
  let text = readFileSync(file, "utf8");
  const at = text.indexOf(BASE_START);
  let base = at >= 0 ? text.slice(at) : text; // everything before the identity line is the (old) role header
  if (prof.tools?.browser === false) base = base.replace(/You have a headless browser.*\n/, "You have no browser tool.\n");
  writeFileSync(file, roleHeader(prof) + base);
  for (const s of prof.skills ?? []) {
    const dir = `${home}/.claude/skills/${slug(s.name)}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/SKILL.md`, `---\nname: ${slug(s.name)}\ndescription: ${String(s.description ?? "").replace(/\n/g, " ")}\n---\n\n${s.instructions ?? ""}\n`);
  }
}

/** Older agents were told to keep notes as files in /data/memory. Rewrites those two instruction lines (idempotent). */
export function migrateMemoryInstructions(file = "/data/workspace/CLAUDE.md") {
  let text: string; try { text = readFileSync(file, "utf8"); } catch { return; }
  if (!text.includes("/data/memory")) return;
  const out = text.split("\n").map((l) => /^Long-term memory: keep durable notes as files in \/data\/memory/.test(l)
    ? 'Long-term memory: orcie keeps it for you across all your conversations. Save durable facts, decisions and commitments with the remember tool (remember "<note>"); look things up with recall and read_room (see "Long-term memory" below). Do not keep notes in files.'
    : /^In chat rooms and DMs you only see what is sent to you.*\/data\/memory/.test(l)
      ? "Orcie records every conversation you take part in and shows you the relevant parts of your other conversations at the start of each turn, so you do not need to write down what you said; use remember only for durable facts worth keeping."
      : l);
  writeFileSync(file, out.join("\n"));
}
