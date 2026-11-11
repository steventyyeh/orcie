// Agent profile (what HR collects when hiring) and the validation rules shared by every entry point.
export const PRESET_NAMES = ["small", "standard", "large"] as const;
export type Skill = { name: string; description: string; instructions: string };
export type Profile = {
  role: string; summary: string; systemPrompt: string; tools: { browser: boolean }; skills: Skill[]; memorySeed: string; resources: (typeof PRESET_NAMES)[number]; greeting?: string;
  team?: string; manager?: string; responsibilities?: string[]; description?: string; // HR fields
};

export const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
export const MODEL_RE = /^claude-[a-z0-9.-]{1,40}$/;
export const validName = (n: unknown): n is string => typeof n === "string" && NAME_RE.test(n);
export const validModel = (m: unknown): m is string => typeof m === "string" && MODEL_RE.test(m);

const str = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
export function cleanProfile(p: any): Profile {
  p = p ?? {};
  const team = str(p.team, 60), manager = str(p.manager, 31), description = str(p.description, 600);
  const responsibilities = (Array.isArray(p.responsibilities) ? p.responsibilities : typeof p.responsibilities === "string" ? p.responsibilities.split("\n") : []).map((r: unknown) => str(r, 200)).filter(Boolean).slice(0, 12);
  return {
    role: str(p.role, 80) || "Assistant", summary: str(p.summary, 400),
    systemPrompt: String(p.systemPrompt ?? "").slice(0, 8000), tools: { browser: p.tools?.browser !== false },
    skills: (Array.isArray(p.skills) ? p.skills : []).slice(0, 6).map((s: any) => ({ name: String(s?.name ?? "skill").slice(0, 40), description: String(s?.description ?? "").slice(0, 300), instructions: String(s?.instructions ?? "").slice(0, 6000) })),
    memorySeed: String(p.memorySeed ?? "").slice(0, 4000), resources: (PRESET_NAMES as readonly string[]).includes(p.resources) ? p.resources : "standard", greeting: p.greeting ? str(p.greeting, 400) : undefined,
    ...(team ? { team } : {}), ...(manager ? { manager } : {}), ...(responsibilities.length ? { responsibilities } : {}), ...(description ? { description } : {}),
  };
}

/** The manager must be an existing agent, not the agent itself, and the reporting line must not loop. Returns an error text or null. */
export function managerError(agent: string, manager: string | undefined, managerOf: (name: string) => string | undefined, exists: (name: string) => boolean): string | null {
  if (!manager) return null;
  if (!validName(manager) || !exists(manager)) return `manager "${manager}" is not an existing agent`;
  if (manager === agent) return "an agent cannot be its own manager";
  for (let cur: string | undefined = manager, hops = 0; cur && hops < 50; cur = managerOf(cur), hops++) if (cur === agent) return `reporting loop: ${manager} already reports (directly or not) to ${agent}`;
  return null;
}
