# Security model

Orcie is a single-operator tool on a personal Mac. Every agent runs inside its own container with all tool permissions and with the operator's Claude subscription and GitHub credential. Treat an agent like a script that runs with those credentials, and anyone who can drive an agent as having them.

## Exposure

| Listener | Bind | Who may call it |
|---|---|---|
| UI/API `:8080` | `127.0.0.1` only (`ORCIE_HOST` to change; do not) | The operator's browser and CLI |
| Agent listener `:8081` | `127.0.0.1`, reached by containers as `host.docker.internal` | Agent containers, each authenticated as itself |
| Private API `:8787` | A Tailscale address (or loopback) only; refuses LAN and public | One trusted remote client with a bearer token |
| Harness `:9090` per container | Published on `127.0.0.1` random port | The server, with the agent's token |

Nothing is public: no Tailscale Funnel, no port forwarding. Containers publish no other ports; the browser's VNC and CDP ports exist only on the container's loopback.

## Request guard (UI/API listener)

`server/src/guard.ts`, tested in `server/test/guard.test.ts` and `api.test.ts` (same rules as Orca's `same_origin_only`):
- `Host` must be `localhost:<port>` or `127.0.0.1:<port>` (blocks DNS rebinding).
- Non-GET requests must have no `Origin`, or the server's own origin (blocks cross-site requests).
- Non-GET requests must be `application/json` (forces a CORS preflight the server never answers).
- The live-browser WebSocket additionally requires the server's own `Origin` and a loopback peer.
- There is no login: loopback is the boundary, so do not run orcie on a shared host.

## Identity between agents

- Each container has its own token (`HMAC-SHA256(server secret, agent name)`, secret at `~/.orcie/server-secret`, mode 600) and only receives its own. The server derives the sender from the token; the `from` field is never trusted (verified: a spoofed `from` is stamped with the real sender; no or wrong token gets 401).
- The harness requires the same token on every endpoint except `/healthz`, so other containers cannot message, cancel or reconfigure an agent.
- A message's `origin` conversation (for reporting back) is accepted only if the sender takes part in it.
- Removing an agent invalidates its token. `/dm` on `:8080` is the human only.

## Credentials

- **Claude**: the operator's subscription only. A long-lived token from `claude setup-token` (`~/.orcie/token`, mode 600) is passed to containers by environment variable; Anthropic API keys are stripped from the server and harness environments and unsupported.
- **GitHub**: one shared token (`~/.orcie/git/token`) mounted read-only at `/gitcreds` in every container agent, read at use time by a credential helper and a `gh` wrapper. Every agent therefore has the operator's GitHub access (scopes of that token). A narrower fine-grained token can replace the file with no other change. External agents (Muse) never get it.
- Tokens are not written to logs, replies or the repo. The private-API token (`~/.orcie/api-token`) is never printed.

## Containers

Non-root user, CPU/memory presets, `--restart unless-stopped`. The container is the sandbox: agents run Claude with `--dangerously-skip-permissions` inside it, can reach the internet, and share the Docker bridge network. They share the operator's credentials above; the model assumes cooperative agents with a human reviewing their work. Dangerous operations (force-push, deletions, deploys) are guarded by policy text in each agent's `CLAUDE.md`, not by a technical control.

## Private API (Muse)

Bearer token (constant-time compare, failed-auth rate limit), audit log, deny list `kfl-*,remica-*` (those agents are invisible to Muse), a fixed external agent identity, loop guard. See [PRIVATE_API.md](PRIVATE_API.md).

## Tmux bridge

Linked sessions run as the operator on the Mac, outside any container, with no sandbox and full permissions. Only sessions named in `link-tmux` are touched. `secretary` and `commander` can **never** be linked (hard-coded); `ORCIE_TMUX_DENY` adds further names.

**Risk to understand.** A linked session turns the web UI into a path to the user's Mac: whoever can send a message in the UI (or an agent that can DM the linked agent) can make that session run commands as the user. The protections are the request guard (UI bound to `127.0.0.1`, Host and Origin checks, JSON-only writes, loopback-only WebSocket) and that the UI is not exposed on any other interface by default. Never set `ORCIE_HOST` to a non-loopback address while a host session is linked, and do not publish port 8080 (tunnels, port forwards). A message from another agent is typed into the session like a user message, so a prompt-injected agent could try to steer it; the loop guard and addressing rules apply, but they are not a sandbox.

**Documented exception (2026-11-16).** `orcie-commander` was on the default deny list. The user explicitly opted in to linking that one session (the operator's own orcie-commander Claude Code session) as the agent `orcie-commander`, so it was removed from the default list. It is an opt-in for this session only; add it back with `ORCIE_TMUX_DENY=orcie-commander` to forbid it again.

**Tools for a linked agent.** `~/.orcie/hosttools/<agent>/bin/` holds `remember`, `recall`, `read_room`, `send_message`, `promise`, `share_file`, `fetch_file` and `orcie-dm`. They use the agent API on loopback with the agent's own token, `HMAC(server secret, agent name)`, kept in `~/.orcie/hosttools/<agent>/token` (mode 600). The server derives the sender from that token, as for container agents, so the agent cannot speak as anyone else, and the server secret itself is never written there. Known limit: messages typed into the session by other channels (for example another Claude session sending to it with tmux) are indistinguishable from bridge messages in the transcript, so a reply made while both are pending can be posted to the UI.

## Files and browser

- Uploaded names are reduced to a base name; downloads are `application/octet-stream` attachments (images inline only), `nosniff`, sandbox CSP. Agents read only files attached in their own conversations.
- The browser profile (cookies, logins) lives on the agent's volume. The operator's "take control" is human-only (token plus loopback), and while held the agent's input and navigation are refused. Pages the agent opens are untrusted content.

## Input validation

Agent names `^[a-z][a-z0-9-]{0,30}$`; models `^claude-[a-z0-9.-]{1,40}$`; resources from an allowlist; Docker is always invoked with argument lists, never a shell string; profile fields are length-limited; managers must exist and cannot form loops (`server/test/profile.test.ts`).

## Known gaps

- No UI authentication (loopback only).
- All agents share the operator's Claude and GitHub credentials, the Docker bridge network and the host's outbound network.
- `orcie.db`, `~/.orcie/files` and `~/.orcie/memory` hold conversation text and notes unencrypted (directories are mode 700).
- Tool output shown in the UI may contain anything an agent printed.
- Per-client private-API tokens and expiry are not implemented.
