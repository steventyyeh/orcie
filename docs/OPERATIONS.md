# Operations

## Start, stop, rebuild

```
colima start                                   # Docker
docker build -t orcie-agent:dev harness        # agent image (rebuild after changing harness/)
node --experimental-strip-types server/src/index.ts   # UI http://127.0.0.1:8080, agent API :8081, private API on the tailnet
npm test                                       # unit and end-to-end tests (no Docker needed)
```

On startup the server recreates any container agent whose container is missing or built from an older image (same volume, so memory, sessions and files stay). Set `ORCIE_AUTO_RECREATE=0` to turn that off. Stop the server by killing the process listening on 8080; containers keep running.

## One-time setup (`~/.orcie`, all mode 600/700, never in git)

| File | Purpose | How |
|---|---|---|
| `token` | Long-lived Claude subscription token for agents | `claude setup-token`, then `scripts/setup-token.sh` (valid a year; renew the same way, then `orcie recreate-all`) |
| `git/token` | Shared GitHub credential | `scripts/export-git-login.sh` |
| `api-token` | Private API bearer token (Muse) | generated on first start |
| `server-secret` | Derives per-agent tokens | generated on first start |
| `creds/` | Fallback copy of the host login | `scripts/export-login.sh` (can expire; prefer `token`) |

Subscription only: there is no API key path.

## Configuration (environment)

`PORT` (8080), `ORCIE_AGENT_PORT` (8081), `ORCIE_HOST` (127.0.0.1), `ORCIE_DB`, `ORCIE_STREAK_LIMIT` (override loop-guard limit), `ORCIE_AUTO_RECREATE`, `ORCIE_API_DENY` (`kfl-*,remica-*`), `ORCIE_TMUX_DENY`, `ORCIE_MEMORY_DIR`, `ORCIE_FILES_DIR`, `ORCIE_BROWSER_LIVE=off` (in a container: no live browser).

## Data and backup

- `orcie.db` (+ `-wal`, `-shm`): agents, conversations, messages (with full-text index), cursors, promises, files index. Stop the server (or use `sqlite3 .backup`) before copying.
- `~/.orcie/memory/<agent>/MEMORY.md`, `~/.orcie/files/`, `~/.orcie/*` credentials.
- Docker volumes `orcie-<agent>-data`: the agent's workspace, Claude sessions, own memory files and browser profile. **Deleted when an agent is laid off.** Back up with `docker run --rm -v orcie-NAME-data:/d -v "$PWD":/b alpine tar czf /b/NAME.tgz -C /d .`.

## CLI (`cli/orcie`)

| Command | What |
|---|---|
| `create <name> [model]`, `ls`, `send <agent> <text>`, `attach <agent>` | hire, list, one message, interactive chat from the terminal |
| `check [agent]` | in-container checks: image, tools, auth, browser, GitHub, server reachability; non-zero exit on any failure |
| `stats` | per agent: busy, conversations, messages sent, open promises, CPU and memory |
| `logs <agent> [n]`, `log <agent>` | container logs, recent turn log |
| `restart [agent... \| --all] [--force]` | restart the agent process; waits until the agent is idle unless `--force` |
| `recreate <agent>`, `recreate-all` | new container on the same volume (after changing auth, image or resources) |
| `layoff <agent> [--confirm <agent>] [--no-archive]` | lay off: asks you to type the name (scripts pass `--confirm <agent>`); saves a workspace archive to `~/.orcie/archives/` first, then deletes container and volume, keeps history. There is no `--yes`, and `rm` is gone |
| `set <agent> [--cpu 2] [--memory 4g] [--disk 20g] [--model <id>] [--restart-ok]` | change limits and model. CPU, memory and disk growth are live (`docker update`, online resize); the first disk limit on an old agent and any shrink restart it on the same volume and need `--restart-ok` (and an idle agent) |
| `drop-backup <agent>` | after a disk migration the old unlimited volume `orcie-<agent>-data` is kept as a backup; this deletes it (type the name to confirm) |
| `promises [agent]`, `search <text>`, `doctor`, `shell <agent>` | open promises, full-text search, GitHub access report, shell in a container |
| `add-external <name>`, `link-tmux <name> <session>`, `tmux-sessions`, `dm <from> <to> <text>` | external agents, host tmux sessions, act as an agent |

## Troubleshooting

- **"Failed to authenticate / OAuth session expired"**: the copied login expired. Use the long-lived token (`claude setup-token`, `scripts/setup-token.sh`), then `orcie recreate-all`. `GET /api/auth` shows the active mode (`token` or `host-login-copy`).
- **An agent does not answer**: `orcie check <agent>`; `orcie logs <agent>`; Stop and Restart in the UI header, or `orcie restart <agent> --force`.
- **"Paused fan-out" in a room**: agents exchanged too many messages without you; post in that conversation to resume.
- **Browser panel blank**: use Reconnect (falls back to screenshots), or Restart browser; `orcie check` reports the browser state.
- **Agent on an old image**: restart the server (auto-recreate) or `orcie recreate <agent>`.
- **Port 8080 busy**: `lsof -tiTCP:8080 -sTCP:LISTEN`.

## Resource limits and disk quotas

Each agent has its own CPU, memory and disk limit, saved in the database and re-applied whenever the container is recreated (startup image upgrade included). UI: **Manage > Resources and model**; CLI: `orcie set`. Bounds: CPU 0.5 to the Docker VM's cores, memory 1 GB to what the VM has (max 32 GB; under 2 GB warns, the browser shares it), disk 2 GB to the VM's data disk.

**Disk is enforced by the filesystem.** overlay2 on colima cannot enforce `--storage-opt size`, so every agent gets a sparse ext4 image in the Docker VM (`/var/lib/docker/orcie-disks/<agent>.img`), loop-mounted (fstab entry, so it comes back after a VM reboot; the server also re-mounts at startup) and exposed as the Docker volume `orcie-<agent>-disk`. Writes past the limit fail with ENOSPC. The server warns in the agent's DM at 80%, 95% and when full, and the panel and `orcie stats` show usage against the limit. Growing is online; shrinking needs the agent offline and is refused unless the data fits (at most 85% full). Everything goes through `colima ssh -- sudo`; on a native Linux host set `ORCIE_VM_EXEC="sudo -n"`. New agents get a limited disk from their preset (small 10, standard 20, large 40 GB; sparse, so unused space costs nothing). Agents created before this change keep an unlimited volume until you set a disk limit (`orcie set <agent> --disk 20g --restart-ok`): the workspace is copied into the new volume, verified by a manifest of every path and size, and the old volume is kept as a backup.
