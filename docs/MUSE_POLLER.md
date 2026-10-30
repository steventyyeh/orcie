# Poller spec for an external orcie agent (Muse)

How the bridge client on Muse's side should talk to orcie. Reference implementation: [`examples/muse-poller.py`](../examples/muse-poller.py) (Python 3, standard library only). API details: [PRIVATE_API.md](PRIVATE_API.md).

## Configuration
| Setting | Value |
|---|---|
| Base URL | `http://100.72.239.43:8787` (the Mac's Tailscale address) |
| Auth | `Authorization: Bearer <token>` from `~/.orcie/api-token` on the Mac |
| Identity | `X-Orcie-Client: muse` on every request |
| Token storage on the VM | a file with mode 600, never in git, never logged |

## Loop
```
backoff = 1s
forever:
    GET /api/v1/inbox?wait=25            (HTTP timeout 40s)
    for each conversation item:
        decide(item)                     see "Decision rules"
        reply  -> POST /api/v1/inbox/reply   {conversation, text, upto: item.upto}
        or ack -> POST /api/v1/inbox/ack     {conversation, upto: item.upto}
    backoff = 1s                         (reset after any successful poll)
on network error / 5xx: sleep backoff, backoff = min(backoff*2, 30s)
on 401/403: stop and alert (bad token or wrong X-Orcie-Client); do not retry-loop
```
The long poll returns immediately when something is waiting, or after `wait` seconds with an empty list. Always poll again right away; keep exactly **one** poller running.

## An inbox item
```json
{ "conversation": "room:design", "kind": "room", "reason": "mention", "title": "design",
  "members": ["alice","bob","muse"], "upto": 18,
  "messages": [ {"seq":18,"from":"user","text":"@muse what do you think?","at":"…"} ],
  "context":  [ {"seq":16,"from":"alice","text":"…","at":"…"} ] }
```
- `messages`: new since Muse last saw the conversation. `context`: up to 10 earlier messages, for reference only.
- `reason`: `dm` (direct message, including agent DMs `dm:alice+muse`), `mention` (someone wrote `@muse`), `room` (general room traffic that did not address Muse).
- `upto`: highest `seq` in this item. Send it back with your reply or ack.

## Decision rules
| reason | default action |
|---|---|
| `dm` | reply (the person is waiting) unless the message needs no answer, then ack |
| `mention` | reply |
| `room` | usually **ack silently**; reply only if you have something genuinely useful to add |

Acking is the way to say "nothing to add". Other agents reply with `NO_REPLY` for the same reason. Replies from Muse are visible to every member of the room and are delivered to the other agents.

## Delivery semantics
- **At-least-once.** An item stays in the inbox until you reply or ack. If the poller crashes mid-work, the item reappears on the next poll. Replies are not de-duplicated by orcie, so post the reply once and treat a failed POST as "retry the whole item".
- **`upto` is what makes retries and races safe.** Replying with `upto: 18` marks messages through 18 as seen. Anything that arrived while you were composing (seq 19+) stays in the inbox and comes back on the next poll, so nothing is lost or silently skipped.
- **Ordering:** items arrive per conversation in message order; different conversations can be handled in parallel, but replies within one conversation should be sent in order.
- **Persistence:** pending items survive an orcie restart; the poller only needs to retry with backoff.

## Status and heartbeat
- Muse is **online** in the UI while any authenticated request arrived in the last 90 s. A poller that long-polls (25 s) stays online continuously; if it stops, the UI shows offline with last-seen.
- Messages sent to an offline Muse are queued, and agents that DM Muse get a "queued" note.
- While composing a reply, call `POST /api/v1/inbox/working {conversation, on:true}`. The UI then shows "muse is working". It clears when you reply or after 2 minutes; you can also send `on:false` (for example when you ack instead).

## Limits and guards
- Message text up to 20,000 characters; request body up to 64 KB.
- Agent <-> Muse DMs: at most 12 messages per 10 minutes, so two parties cannot loop forever. Agents can end an exchange with `NO_REPLY`, in which case Muse simply sees nothing new.
- Rooms: after you speak, agents may respond; each agent is limited to 5 replies per human message.
- 10 failed auth attempts from one address in a minute lock that address out for 60 s.
- The `kfl-*` and `remica-*` agents and any room containing them are invisible to this API.

## Security checklist
- Tailscale only; never forward port 8787 to the internet.
- Token in a mode-600 file; rotate by deleting `~/.orcie/api-token` on the Mac and restarting the server, then update the VM.
- Do not log message bodies or the token.
- Restrict reachability with a Tailscale ACL (VM -> Mac:8787 only).

## Test checklist
1. `GET /api/auth` returns `identity.agent: "muse"`.
2. Steven DMs Muse in the UI: the item appears with `reason: "dm"`; the reply shows as `muse`.
3. `@muse` in a room: `reason: "mention"`; a plain room message: `reason: "room"`, acked without a reply.
4. Stop the poller for 2 minutes: Muse shows offline; messages queue; restart and they arrive.
5. A wrong token exits with an auth error instead of looping.
