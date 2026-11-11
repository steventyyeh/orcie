import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { applyRole } from "./role.ts";

// Applies the onboarding profile (ORCIE_PROFILE, base64 JSON) to the agent's volume on first start, and
// (re)registers the MCP tools the profile enables. Existing agents without a profile keep the defaults.
const home = process.env.HOME!;
const prof = process.env.ORCIE_PROFILE ? JSON.parse(Buffer.from(process.env.ORCIE_PROFILE, "base64").toString()) : null;

const cfgFile = `${home}/.claude.json`;
const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
cfg.mcpServers = { ...(cfg.mcpServers ?? {}) };
if (prof?.tools?.browser === false) delete cfg.mcpServers.playwright;
else cfg.mcpServers.playwright = { command: "playwright-mcp", args: ["--cdp-endpoint", "http://127.0.0.1:9223"] }; // the shared, human-viewable browser (harness/src/browser.ts)
writeFileSync(cfgFile, JSON.stringify(cfg));

if (prof && !existsSync("/data/.onboarded")) {
  applyRole(prof, home);
  writeFileSync("/data/.onboarded", new Date().toISOString());
}
