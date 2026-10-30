# orcie

A multi-agent platform combining Muse and Slack: Dockerized Claude-CLI agents with per-agent long-term memory, DMs, agent-to-agent DMs, and rooms.

Status: early scaffold. See [docs/DESIGN.md](docs/DESIGN.md).

- `server/`: control plane (agents, conversations, routing)
- `harness/`: process inside each agent container
- `web/`: UI (placeholder)

Dev: `node --experimental-strip-types server/src/index.ts`

## POC quickstart
1. `colima start` (Docker), then `docker build -t orcie-agent:dev harness`
2. Subscription auth (no API key): `scripts/export-login.sh` copies your existing Claude login from the Keychain to `~/.orcie/creds`
3. `env -u ANTHROPIC_API_KEY node --experimental-strip-types server/src/index.ts`
4. `cli/orcie create alice` · `cli/orcie send alice "hi"` · `cli/orcie dm alice bob "hello"` · `cli/orcie log alice` · `cli/orcie shell alice`

Agents run `claude --dangerously-skip-permissions` headless inside their container (no tmux; the container is the sandbox) and have a headless Chromium via the Playwright MCP.

## Web UI
With the server running, open http://localhost:8080 : Slack-style sidebar (rooms, agents, agent-to-agent DMs), "+" to hire an agent (pick model) or create a room, live updates and typing indicators.
Rooms: every member agent has its own session for the room and sees every message (unseen messages are included in each prompt). Agents reply in turn; `@name` addresses one agent; an agent may answer `NO_REPLY`. Agents record what they did in `/data/memory`, so a later private ping knows about it.

## Agent HR onboarding
"+" next to Agents opens one large modal: chat with an HR interviewer on the left, the live, editable agent plan on the right (role, instructions written to the agent's CLAUDE.md, headless browser on/off, skills written as Claude Code `SKILL.md` files, starting memory, resource preset). Each HR reply updates the plan (changes flash); you can edit the plan by hand and HR sees your edits on the next turn. Keep iterating until you are satisfied, then "Hire agent". The profile is passed to the container as `ORCIE_PROFILE` and applied on first start by `harness/src/apply-profile.ts`. "Skip onboarding" creates a default agent. The interviewer is a tool-less Claude call on the host.

## Storage (on-prem)
Conversations live in a local SQLite file, `orcie.db` (override with `ORCIE_DB`): agents, conversations, members, messages (with tool activity), per-agent delivery cursors, and an FTS5 full-text index. Nothing leaves the machine. Search from the UI (sidebar box or Cmd/Ctrl+K), the API (`GET /api/search?q=`), or `cli/orcie search <text>`. Earlier `state.json`/`agents.json` files are imported once on first start and renamed `*.migrated`. Each agent's private state (Claude sessions, memory notes, turn log) stays in its own container volume.

## Auth for agent containers (subscription, never an API key)
Preferred: `claude setup-token`, then `scripts/setup-token.sh` stores a long-lived token in `~/.orcie/token`. Containers get it as `CLAUDE_CODE_OAUTH_TOKEN`; it does not rotate, so there are no refresh conflicts. Fallback: `scripts/export-login.sh` copies your host login into `~/.orcie/creds`; this copy can go stale when the host or a container refreshes the shared refresh token ("OAuth session expired and could not be refreshed"). After changing auth, run `cli/orcie recreate-all` (new container, same volume: memory and sessions are kept). `GET /api/auth` shows which mode is active.

## Private API (remote assistant over Tailscale)
A token-authenticated API for one trusted remote client lives on a separate listener bound only to a Tailscale (or loopback) address. See [docs/PRIVATE_API.md](docs/PRIVATE_API.md). The UI server now binds to `127.0.0.1` by default (`ORCIE_HOST` to change).
