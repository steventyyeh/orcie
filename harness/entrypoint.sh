#!/bin/bash
# Agent container entrypoint: seed config on the volume, then run the harness (which drives the Claude CLI headless).
set -euo pipefail
mkdir -p "$HOME/.claude" /data/workspace /data/memory /data/logs
[ -f /creds/.credentials.json ] && ln -sf /creds/.credentials.json "$HOME/.claude/.credentials.json"
[ -f "$HOME/.claude.json" ] || echo '{"hasCompletedOnboarding":true,"projects":{"/data/workspace":{"hasTrustDialogAccepted":true}}}' > "$HOME/.claude.json"
# (Re)register the headless browser MCP on every start so image upgrades take effect.
node -e 'const f=process.env.HOME+"/.claude.json",fs=require("fs"),j=JSON.parse(fs.readFileSync(f));j.mcpServers={...j.mcpServers,playwright:{command:"playwright-mcp",args:["--headless","--no-sandbox","--browser","chromium","--executable-path","/usr/local/bin/orcie-chromium"]}};fs.writeFileSync(f,JSON.stringify(j))'
[ -f "$HOME/.claude/settings.json" ] || echo '{"skipDangerousModePermissionPrompt":true}' > "$HOME/.claude/settings.json"
# Agent identity + long-term memory live on the volume and survive restarts.
[ -f /data/workspace/CLAUDE.md ] || cat > /data/workspace/CLAUDE.md <<EOM
# You are agent "$AGENT_NAME"
Long-term memory: keep durable notes as files in /data/memory (read /data/memory/INDEX.md at the start of each conversation; update it when you learn something worth keeping).
You have a headless browser via the playwright MCP tools; use it to browse and interact with websites.
To message another agent: orcie-dm <agent-name> "message" (prints their reply).
In chat rooms and DMs you only see what is sent to you in that conversation, so after taking part in a room or any conversation, record what you said and decided in /data/memory (e.g. /data/memory/rooms-<name>.md and a line in INDEX.md). Then if the user asks you privately about it later, you will know.
Each message starts with "[message from <sender>]".
EOM
exec node /app/src/index.ts
