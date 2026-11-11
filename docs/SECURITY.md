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

Linked sessions run as the operator on the Mac, outside any container, with no sandbox. Only sessions named in `link-tmux` are touched; `ORCIE_TMUX_DENY` (default `orcie-commander,secretary,commander`) can never be linked.

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
