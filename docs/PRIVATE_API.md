# Orcie private API

A small, token-authenticated HTTP API for **one trusted remote client** (for example Muse running on a Tailscale VM) to talk to Orcie agents and rooms. It is separate from the UI server and is never exposed publicly.

## Network model

| Listener | Default address | Auth | Purpose |
|---|---|---|---|
| UI / internal API | `127.0.0.1:8080` | none (local only) | web UI, CLI, agent containers (`orcie-dm`) |
| **Private API** | `<tailscale-ip>:8787` | **Bearer token** | this document |

- The private API binds **only** to a Tailscale address (`tailscale ip -4`, a `100.64.0.0/10` address) or to loopback. Any other address (`0.0.0.0`, a LAN or public IP) is refused at startup.
- If Tailscale has no address yet (not logged in), the listener stays off and retries every 30 s.
- For local testing: `ORCIE_API_HOST=127.0.0.1`.
- Restrict who can reach `:8787` with a Tailscale ACL (the VM only).

**Base URL:** `http://<tailscale-ip-of-the-mac>:8787` (or the MagicDNS name, `http://<mac-name>:8787`).

## Authentication

Every request needs:

```
Authorization: Bearer <token>
```

- The token is generated on first server start and stored at `~/.orcie/api-token` (mode 600). It is **never in git** and never printed in logs.
- To rotate: delete the file and restart the server (a new token is generated); give the new value to the client.
- Wrong or missing token returns `401`. After 10 failures from one address in a minute, that address gets `429` for 60 s.
- Optional header `X-Orcie-Client: <name>` (`[a-z0-9-]`, up to 20 chars, default `api`). It becomes the **sender name** shown in conversations (for example `muse`), so Steven can see who wrote a message. Names of existing agents, `user` and `system` are rejected.

Requests are logged (time, address, client, method, path, status; no bodies, no token) to `~/.orcie/api-audit.log`.

## Scope limits

- **Single user, orcie only.** No user accounts.
- **Deny list:** agents whose names match `ORCIE_API_DENY` (default `kfl-*,remica-*`) are invisible to this API and cannot be messaged or read. Rooms that contain a denied agent are hidden too.
- Bodies are capped at 64 KB; message text at 20,000 characters.
- Agent credentials (Claude login, git token) are never exposed. `GET /api/auth` reports only which auth mode the agent containers use.

## Endpoints

All responses are JSON.

### `GET /api/auth` (alias `GET /api/v1/auth`)
Check the token works and see how agent containers authenticate to Claude.
```json
{ "api": "ok", "client": "muse", "agentAuth": "host-login-copy" }
```
`agentAuth` is `token` (long-lived subscription token, recommended), `host-login-copy` (copy of the host login, can go stale) or `none`.

### `GET /api/v1/agents`
```json
{ "agents": [ { "name": "alice", "model": "claude-sonnet-5-5", "role": null, "busy": false, "conversation": "dm:alice" } ] }
```

### `GET /api/v1/rooms`
```json
{ "rooms": [ { "id": "room:design", "title": "design", "members": ["alice","bob"], "mode": "parallel", "messages": 14, "busy": false, "last": { "conv": "room:design", "seq": 14, "from": "alice", "text": "…", "at": "2026-10-30T03:24:30.000Z" } } ] }
```

### `POST /api/v1/agents/{name}/messages`
Send a direct message to an agent. Body:
```json
{ "text": "Hello", "wait": true, "timeout": 120 }
```
- `wait` (optional, default `false`): hold the request until the agent has finished replying (or `timeout` seconds, 5 to 600, default 120).
- Without `wait`: `202 Accepted` with the message you sent; read replies later with the GET below.
- With `wait`: `200` with `settled` (`true` if the agent finished, `false` on timeout) and `replies` (everything posted after your message).

```json
{ "sent": { "conv": "dm:bob", "seq": 35, "from": "muse", "text": "Hello", "at": "…" },
  "settled": true,
  "replies": [ { "conv": "dm:bob", "seq": 36, "from": "bob", "text": "Hi Muse…", "at": "…", "toolCalls": 1 } ] }
```

### `POST /api/v1/rooms/{id}/messages`
Same body and response. `{id}` is `design` or `room:design`. The message is delivered to every member agent at once (unless you `@name` one). With `wait`, `replies` includes every agent's replies in the room, including agent-to-agent discussion, until the room goes quiet.

### `GET /api/v1/agents/{name}/messages` and `GET /api/v1/rooms/{id}/messages`
Read a conversation. Query: `after=<seq>` (only newer messages), `limit=<n>` (default 50, max 200).
```json
{ "conversation": "dm:bob", "busy": false, "messages": [ { "conv": "dm:bob", "seq": 36, "from": "bob", "text": "…", "at": "…" } ] }
```
`busy: true` means an agent is still working. Poll with `after=<last seq you saw>` until `busy` is `false`.

### Errors
`400` bad input, `401` bad token, `404` unknown or hidden agent/room, `413` too large, `429` too many failed attempts.

## Examples

```bash
BASE=http://100.x.y.z:8787          # the Mac's Tailscale address
TOKEN=...                           # contents of ~/.orcie/api-token on the Mac (keep it secret)
H=(-H "Authorization: Bearer $TOKEN" -H "X-Orcie-Client: muse" -H "Content-Type: application/json")

# status
curl -s "${H[@]}" $BASE/api/auth

# list
curl -s "${H[@]}" $BASE/api/v1/agents
curl -s "${H[@]}" $BASE/api/v1/rooms

# DM an agent and wait for the reply
curl -s "${H[@]}" -d '{"text":"Summarize what you know about the logo decision.","wait":true,"timeout":120}' \
  $BASE/api/v1/agents/alice/messages

# post to a room without waiting, then poll for replies
curl -s "${H[@]}" -d '{"text":"@alice @bob please review the API conventions doc."}' $BASE/api/v1/rooms/design/messages
curl -s "${H[@]}" "$BASE/api/v1/rooms/design/messages?after=14"
```

## Setup checklist (one time, on the Mac)

1. Log in to Tailscale on the Mac and the VM.
2. Start the server (`node --experimental-strip-types server/src/index.ts` from the repo root). The log shows `private API on http://100.x.y.z:8787`.
3. Read the token from `~/.orcie/api-token` and give it to the client over a trusted channel.
4. In the Tailscale admin ACLs, allow only the VM to reach the Mac on port 8787.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ORCIE_API_HOST` | Tailscale IPv4 (auto) | bind address; must be loopback or a Tailscale address |
| `ORCIE_API_PORT` | `8787` | private API port |
| `ORCIE_API_TOKEN_FILE` | `~/.orcie/api-token` | token location |
| `ORCIE_API_DENY` | `kfl-*,remica-*` | comma-separated agent name globs the API cannot see |
| `ORCIE_HOST` | `127.0.0.1` | bind address of the UI server (agent containers still reach it) |

## Not included (yet)

Creating or deleting agents and rooms, message search, streaming (SSE) of replies, per-client tokens, and token expiry. Ask if you need any of these.
