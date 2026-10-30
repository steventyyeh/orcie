#!/bin/bash
# Starts the agent: interactive Claude CLI inside tmux (host-tmux model, now in a container), plus the HTTP shim.
set -euo pipefail
mkdir -p "$HOME/.claude" /data/workspace /data/inbox /data/memory
# Pre-seed config so a fresh container skips onboarding / trust / permission prompts.
[ -f "$HOME/.claude.json" ] || echo '{"hasCompletedOnboarding":true,"projects":{"/data/workspace":{"hasTrustDialogAccepted":true}},"mcpServers":{"playwright":{"command":"playwright-mcp","args":["--headless","--no-sandbox","--browser","chromium"]}}}' > "$HOME/.claude.json"
[ -f "$HOME/.claude/settings.json" ] || echo '{"skipDangerousModePermissionPrompt":true}' > "$HOME/.claude/settings.json"
# Agent identity + long-term memory live on the volume and survive restarts.
[ -f /data/workspace/CLAUDE.md ] || cat > /data/workspace/CLAUDE.md <<EOM
# You are agent "$AGENT_NAME"
Long-term memory: keep durable notes as files in /data/memory (read /data/memory/INDEX.md at the start of each session).
You have a headless browser via the playwright MCP tools; use it to browse and interact with websites.
Messages arrive as a pointer to a file in /data/inbox; read it and act on it.
To DM another agent: orcie-dm <agent-name> "message". Replies to you arrive the same way.
EOM
if ! tmux has-session -t agent 2>/dev/null; then
  CONT=""; [ -n "$(ls -A "$HOME/.claude/projects" 2>/dev/null)" ] && CONT="--continue"
  tmux new-session -d -s agent -x 200 -y 50 -c /data/workspace \
    "claude --dangerously-skip-permissions --model ${ORCIE_MODEL:-claude-sonnet-5-5} $CONT; sleep 3600"
fi
exec node /app/src/index.ts
