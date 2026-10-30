import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Applies the onboarding profile (ORCIE_PROFILE, base64 JSON) to the agent's volume on first start, and
// (re)registers the MCP tools the profile enables. Existing agents without a profile keep the defaults.
const home = process.env.HOME!;
const prof = process.env.ORCIE_PROFILE ? JSON.parse(Buffer.from(process.env.ORCIE_PROFILE, "base64").toString()) : null;
const slug = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "skill";

const cfgFile = `${home}/.claude.json`;
const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
cfg.mcpServers = { ...(cfg.mcpServers ?? {}) };
if (prof?.tools?.browser === false) delete cfg.mcpServers.playwright;
else cfg.mcpServers.playwright = { command: "playwright-mcp", args: ["--headless", "--no-sandbox", "--browser", "chromium", "--executable-path", "/usr/local/bin/orcie-chromium"] };
writeFileSync(cfgFile, JSON.stringify(cfg));

if (prof && !existsSync("/data/.onboarded")) {
  let base = readFileSync("/data/workspace/CLAUDE.md", "utf8");
  if (prof.tools?.browser === false) base = base.replace(/You have a headless browser.*\n/, "You have no browser tool.\n");
  writeFileSync("/data/workspace/CLAUDE.md", `# Role: ${prof.role}\n\n${prof.summary ?? ""}\n\n${prof.systemPrompt ?? ""}\n\n---\n\n${base}`);
  for (const s of prof.skills ?? []) {
    const dir = `${home}/.claude/skills/${slug(s.name)}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/SKILL.md`, `---\nname: ${slug(s.name)}\ndescription: ${String(s.description ?? "").replace(/\n/g, " ")}\n---\n\n${s.instructions ?? ""}\n`);
  }
  mkdirSync("/data/memory", { recursive: true });
  writeFileSync("/data/memory/about-me.md", `# About my role\n\n${prof.role}: ${prof.summary ?? ""}\n\n${prof.memorySeed ?? ""}\n`);
  const idx = existsSync("/data/memory/INDEX.md") ? readFileSync("/data/memory/INDEX.md", "utf8") : "";
  writeFileSync("/data/memory/INDEX.md", `- about-me.md: my role and the context I was onboarded with\n${idx}`);
  writeFileSync("/data/.onboarded", new Date().toISOString());
}
