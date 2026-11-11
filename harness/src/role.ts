import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Writes an agent's role (from its HR profile) onto its volume: the header of CLAUDE.md, skills and the memory seed.
// Used on first start and again whenever the profile is edited after hiring.
const slug = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "skill";
const BASE_START = '# You are agent "'; // the entrypoint's base CLAUDE.md always starts with this

export function roleHeader(prof: any): string {
  const hr = [prof.team ? `Team: ${prof.team}` : "", prof.manager ? `Reports to: ${prof.manager}` : "", prof.description ? `About this role: ${prof.description}` : ""].filter(Boolean).join("\n");
  const resp = Array.isArray(prof.responsibilities) && prof.responsibilities.length ? `Responsibilities:\n${prof.responsibilities.map((r: string) => `- ${r}`).join("\n")}` : "";
  return [`# Role: ${prof.role}`, prof.summary ?? "", hr, resp, prof.systemPrompt ?? ""].filter(Boolean).join("\n\n") + "\n\n---\n\n";
}

export function applyRole(prof: any, home: string, opts: { memory?: boolean } = {}) {
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
  if (opts.memory !== false) {
    mkdirSync("/data/memory", { recursive: true });
    writeFileSync("/data/memory/about-me.md", `# About my role\n\n${prof.role}: ${prof.summary ?? ""}\n\n${prof.memorySeed ?? ""}\n`);
    const idx = existsSync("/data/memory/INDEX.md") ? readFileSync("/data/memory/INDEX.md", "utf8") : "";
    if (!idx.includes("about-me.md")) writeFileSync("/data/memory/INDEX.md", `- about-me.md: my role and the context I was onboarded with\n${idx}`);
  }
}
