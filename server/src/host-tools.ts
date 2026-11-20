// Orcie tools for an agent that runs on the host (a linked tmux session): remember, recall, read_room, send_message, promise,
// share_file, fetch_file and orcie-dm. They are the same scripts the container agents use (harness/bin), wrapped so that:
//  - identity is this agent's own token, derived from the server secret by the server (never the secret itself) and kept in a mode-600 file;
//  - the agent API is the loopback listener, so nothing new is exposed;
//  - the current conversation comes from a file the bridge writes before each turn.
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ORCIE_DIR } from "./env.ts";
import { agentToken } from "./guard.ts";

export const TOOLS = ["remember", "recall", "read_room", "send_message", "promise", "remind_me", "list_reminders", "cancel_reminder", "share_file", "fetch_file", "orcie-dm"];
export const hostToolsDir = (agent: string) => `${ORCIE_DIR}/hosttools/${agent}`;
const REPO = resolve(import.meta.dirname, "../..");

export function installHostTools(agent: string, secret: string, agentPort: number, host = "127.0.0.1") {
  const dir = hostToolsDir(agent), bin = `${dir}/bin`;
  mkdirSync(bin, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  writeFileSync(`${dir}/token`, agentToken(secret, agent), { mode: 0o600 }); chmodSync(`${dir}/token`, 0o600);
  if (!existsSync(`${dir}/conv`)) writeFileSync(`${dir}/conv`, "", { mode: 0o600 });
  for (const t of TOOLS) {
    const target = t === "orcie-dm" ? `${REPO}/harness/bin/orcie-dm` : `${REPO}/harness/bin/orcie-tool`;
    writeFileSync(`${bin}/${t}`, `#!/bin/bash
# orcie host tool "${t}" for agent ${agent}. Identity: this agent's own token file (derived server-side; the server secret is not on this path).
D="${dir}"
export ORCIE_SERVER="http://${host}:${agentPort}" ORCIE_AGENT_TOKEN="$(cat "$D/token")" ORCIE_CONVERSATION="$(cat "$D/conv" 2>/dev/null)" ORCIE_TOOL="${t}" ORCIE_FILES_DEST="$D/files"
exec "${target}" "$@"
`, { mode: 0o700 });
    chmodSync(`${bin}/${t}`, 0o700);
  }
  return { dir, bin };
}
export function removeHostTools(agent: string) { rmSync(hostToolsDir(agent), { recursive: true, force: true }); }
