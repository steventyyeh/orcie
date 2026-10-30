# orcie

A multi-agent platform combining Muse and Slack: Dockerized Claude-CLI agents with per-agent long-term memory, DMs, agent-to-agent DMs, and rooms.

Status: early scaffold. See [docs/DESIGN.md](docs/DESIGN.md).

- `server/`: control plane (agents, conversations, routing)
- `harness/`: process inside each agent container
- `web/`: UI (placeholder)

Dev: `node --experimental-strip-types server/src/index.ts`

## POC quickstart
1. `colima start` (Docker), then `docker build -t orcie-agent:dev harness`
2. Subscription auth (no API key): run `claude setup-token`, then `echo 'CLAUDE_CODE_OAUTH_TOKEN=<token>' > .env && chmod 600 .env`
3. `set -a; . ./.env; set +a; unset ANTHROPIC_API_KEY; node --experimental-strip-types server/src/index.ts`
4. `cli/orcie create alice` · `cli/orcie send alice "hi"` · `cli/orcie dm alice bob "hello"` · `cli/orcie attach alice`

Agents run `claude --dangerously-skip-permissions` inside their container (the container is the sandbox) and have a headless Chromium via the Playwright MCP.
