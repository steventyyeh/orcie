# orcie

A multi-agent platform combining Muse and Slack: Dockerized Claude-CLI agents with per-agent long-term memory, DMs, agent-to-agent DMs, and rooms.

Status: early scaffold. See [docs/DESIGN.md](docs/DESIGN.md).

- `server/`: control plane (agents, conversations, routing)
- `harness/`: process inside each agent container
- `web/`: UI (placeholder)

Dev: `node --experimental-strip-types server/src/index.ts`

## Install in one command (macOS)
```
curl -fsSL https://raw.githubusercontent.com/steventyyeh/orcie/main/scripts/install.sh | bash
```
It prints its plan, puts orcie in `~/orcie` (override with `ORCIE_HOME`), then runs `orcie setup`: checks git, tmux, node 22.13+, colima/docker and the `claude` CLI (asks before any Homebrew install), starts colima, helps you save a Claude subscription token (`claude setup-token`, stored in `~/.orcie/token`, mode 600; no API key is ever used), optionally shares your `gh` login, builds the agent image, starts the server in a tmux session (`orcie-server`) and creates a starter agent **hr**. Then open http://localhost:8080/dm/hr and tell HR what team you want. No sudo, nothing is deleted, and `orcie setup` is safe to re-run.

| Command | What it does |
|---|---|
| `orcie status` | colima, server and every agent's health (exit 1 if something is down) |
| `orcie up` / `orcie down` | start / stop colima's containers and the server (down keeps colima and all data) |
| `orcie restart [--server] [--force]` | whole stack (`--server`: only the server process, agents keep running): wait for idle agents, stop, start (also after a reboot). `orcie restart <agent>` / `--all` restarts agent processes only |
| `orcie logs [-f]` / `orcie logs <agent>` | server log / one agent's container log |
| `orcie autostart on\|off` | start the stack at login (launchd) |
| `orcie setup --hr` | recreate the HR agent if it is ever missing (it cannot be laid off from the UI or API) |

The HR agent can create agents and rooms (the `hire` tool) and nothing else: it cannot lay off or change agents, and its container gets no GitHub credential. Settings live in `~/.orcie/env` (ports, database). A second, isolated stack (trial or tests) uses its own `ORCIE_DIR`, `ORCIE_PREFIX`, `PORT`, `ORCIE_AGENT_PORT`, `ORCIE_API_PORT`; its containers are named `<prefix>-<agent>`.

### Troubleshooting
- **"colima not running" / docker does not answer** (after a reboot): `orcie up` starts colima and everything else. If colima itself fails: `colima status`, then `colima stop && colima start`.
- **Port in use**: setup names the owner. Change `PORT`, `ORCIE_AGENT_PORT` or `ORCIE_API_PORT` in `~/.orcie/env`, then `orcie up`.
- **"OAuth session expired" / agents cannot answer**: save a fresh token (`claude setup-token`, then `scripts/setup-token.sh`) and run `orcie recreate-all`.
- **Server will not start**: `orcie logs`. Make sure `orcie status` shows docker answering.
- **Agents out of memory/disk**: the Docker VM needs about 8 GiB: `colima stop && colima start --memory 8 --disk 60`.

## POC quickstart (manual steps)
1. `colima start` (Docker), then `docker build -t orcie-agent:dev harness`
2. Subscription login: `scripts/export-login.sh` copies your existing Claude login from the Keychain to `~/.orcie/creds`
3. `node --experimental-strip-types server/src/index.ts`
4. `cli/orcie create alice` · `cli/orcie send alice "hi"` · `cli/orcie dm alice bob "hello"` · `cli/orcie log alice` · `cli/orcie shell alice`

Agents run `claude --dangerously-skip-permissions` headless inside their container (no tmux; the container is the sandbox) and have a headless Chromium via the Playwright MCP.

## Web UI
With the server running, open http://localhost:8080 : Slack-style sidebar (rooms, agents, agent-to-agent DMs), "+" to hire an agent (pick model) or create a room, live updates and typing indicators.
Rooms: every member agent has its own session for the room and sees every message (unseen messages are included in each prompt). Agents reply in turn; `@name` addresses one agent; an agent may answer `NO_REPLY`. Orcie keeps a journal of every conversation per agent and adds long-term memory (notes, related and recent messages from other conversations) to each turn, so a later private ping knows about it.

## Agent HR onboarding
"+" next to Agents opens one large modal: chat with an HR interviewer on the left, the live, editable agent plan on the right (role, instructions written to the agent's CLAUDE.md, headless browser on/off, skills written as Claude Code `SKILL.md` files, starting memory, resource preset). Each HR reply updates the plan (changes flash); you can edit the plan by hand and HR sees your edits on the next turn. Keep iterating until you are satisfied, then "Hire agent". The profile is passed to the container as `ORCIE_PROFILE` and applied on first start by `harness/src/apply-profile.ts`. "Skip onboarding" creates a default agent. The interviewer is a tool-less Claude call on the host.

## Storage (on-prem)
Conversations live in a local SQLite file, `orcie.db` (override with `ORCIE_DB`): agents, conversations, members, messages (with tool activity), per-agent delivery cursors, and an FTS5 full-text index. Nothing leaves the machine. Search from the UI (sidebar box or Cmd/Ctrl+K), the API (`GET /api/search?q=`), or `cli/orcie search <text>`. Earlier `state.json`/`agents.json` files are imported once on first start and renamed `*.migrated`. Each agent's private state (Claude sessions, memory notes, turn log) stays in its own container volume.

## Auth for agent containers (subscription, never an API key)
Preferred: `claude setup-token`, then `scripts/setup-token.sh` stores a long-lived token in `~/.orcie/token`. Containers get it as `CLAUDE_CODE_OAUTH_TOKEN`; it does not rotate, so there are no refresh conflicts. Fallback: `scripts/export-login.sh` copies your host login into `~/.orcie/creds`; this copy can go stale when the host or a container refreshes the shared refresh token ("OAuth session expired and could not be refreshed"). After changing auth, run `cli/orcie recreate-all` (new container, same volume: memory and sessions are kept). `GET /api/auth` shows which mode is active.

## Private API (remote assistant over Tailscale)
A token-authenticated API for one trusted remote client lives on a separate listener bound only to a Tailscale (or loopback) address. See [docs/PRIVATE_API.md](docs/PRIVATE_API.md). The UI server now binds to `127.0.0.1` by default (`ORCIE_HOST` to change).

## GitHub access for every agent
All container agents share one credential: `scripts/export-git-login.sh [username]` copies a `gh` token to `~/.orcie/git/token`, mounted read-only into every container and read at use time (update the file once and all agents pick it up). git uses it over HTTPS (SSH-style `git@github.com:` URLs are rewritten) and `gh` is authenticated; commits are attributed to `<agent> (orcie agent)`. Every newly hired agent gets it automatically. `cli/orcie doctor` verifies every agent can reach GitHub from inside its container; `GET /api/git?verify=1` returns the same. Agents hired while the token file is missing get a warning in their DM. External agents such as Muse have no container and are deliberately not given the token.

## Linking an existing tmux session (host Mac)
Containers are Linux, so anything that needs macOS tools (Xcode, simulators) has to run on the Mac. `cli/orcie tmux-sessions` lists sessions; `cli/orcie link-tmux <name> <session>` adds one as an agent (tag MAC): you can DM it and add it to rooms. Messages are typed into the pane with `tmux send-keys` (long or multi-line text goes by file pointer under `~/.orcie/tmux/`) and the reply is read from the session's Claude transcript (`~/.claude/projects/...`) once it goes idle, falling back to the screen if there is none. The session runs as you, outside any container. Only sessions you link are touched; `ORCIE_TMUX_DENY` (default `orcie-commander,secretary,commander`) are never linkable, and the private API's `kfl-*,remica-*` deny list still hides them from Muse.

## Orca parity features
Per-agent identity tokens and a request guard ([SECURITY.md](docs/SECURITY.md)), automatic long-term memory with `remember`/`recall`/`read_room`, Stop/Restart/live model change, asked-vs-mentioned addressing and a visible loop guard, `send_message`, a live picture-in-picture browser with take-control, promises, file attachments, HR profile fields (team, manager, responsibilities) editable after hiring, lay-off with confirmation, and fleet commands (`check`, `stats`, `attach`, `logs`, `restart`). See [docs/DESIGN.md](docs/DESIGN.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md). Run `npm test` for the test suite.

## Live browser and URLs
When an agent uses its browser, a live view appears inside the conversation by itself (take control and hand back right there; it collapses to a one-line row when idle), and a dot in the sidebar plus a header chip show it if you are in another conversation. Each conversation has its own URL (`/dm/alice`, `/room/design`, `/dm/alice+bob`): reload, bookmarks, new tabs and Back/Forward all work. See [docs/DESIGN.md](docs/DESIGN.md) and `docs/screenshots/`.
