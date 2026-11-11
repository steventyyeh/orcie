# Orcie design

Status: matches the code as of the Orca-parity work (2026-11). Operations: [OPERATIONS.md](OPERATIONS.md). Security model: [SECURITY.md](SECURITY.md).

Orcie is a multi-agent platform for one operator: Slack-style chat (agents list, DMs, rooms, agent-to-agent DMs) over agents that are long-running Docker containers, each driving the Claude CLI headless with the operator's **subscription login** (never an API key). It replaces the older tmux-per-agent setup; host tmux sessions can still be linked where macOS tools are needed. The reference for the room, memory and browser behaviour is Orca (`/Users/steveyeh/agent2/Note/orca`); orcie ports the behaviour, not the code.

## 1. Goals and non-goals

Goals: one container per agent with its own volume (workspace, memory, browser profile); Slack-like UI; agent-to-agent DMs and multi-agent rooms; long-term memory across all of an agent's conversations; "Agent HR" (hire with an interview, edit the profile, restart, change model, lay off); a live, shareable browser; fleet operations from a CLI.

Non-goals: multi-user auth or tenancy (one operator, loopback only), remote hosts, a technical permission policy beyond the container sandbox (agents run with all permissions inside it).

## 2. Architecture

```
 browser UI ──► UI/API listener 127.0.0.1:8080 (request guard) ─┐
 orcie CLI  ──►                                                 │
                                                                ▼
 agent containers ──► agent listener 127.0.0.1:8081      ┌───────────────┐        ┌──────────────┐
   (per-agent token, sender = token)  ───────────────►   │ orcie server  │◄──────►│ SQLite (WAL, │
 Muse (VM on tailnet) ► private API  <tailscale-ip>:8787 │ router, HR,   │        │ FTS5)        │
   (bearer token, deny list)                             │ memory, files │        └──────────────┘
                                                         └───────┬───────┘
                          docker run/exec + harness HTTP (token) │ tmux send-keys (linked sessions only)
                  ┌───────────────┬──────────────┬───────────────┘
            container agent  container agent   host tmux session (kind "tmux")
            harness + claude  ...              external agent (kind "external", polls the private API)
```

| Piece | Where | Role |
|---|---|---|
| UI | `web/index.html` (single file, vanilla JS), vendored `web/novnc` | Sidebar, chat, HR wizard, live-browser panel |
| Server | `server/src/index.ts` and modules | Source of truth, routing, HR, container manager, memory, files |
| Agent listener | `server/src/agent-api.ts` | Authenticated calls from containers (`/dm`, memory, `send_message`, promises, files, browser help) |
| Private API | `server/src/private-api.ts` | One trusted remote client (Muse), Tailscale-only; see [PRIVATE_API.md](PRIVATE_API.md) |
| Harness | `harness/src/*` in every container | `/send` (one turn per message, streamed), `/cancel`, `/profile`, `/browser/*`, browser stack |
| tmux bridge | `server/src/tmux-bridge.ts` | Types into a linked host session, reads its Claude transcript for the reply |

Agent kinds: `claude` (container), `external` (no container; bridged through the private API), `tmux` (existing host Claude session). The server runs directly on Node with `--experimental-strip-types` (no build step).

## 3. Data model (SQLite, `orcie.db`)

`agents` (name, model, container, profile JSON, kind, last_seen, last_reply), `conversations` (id, kind dm|room, title, mode, meta {origin, async}), `members`, `messages` (conv, seq, sender, text, at, hop, activity JSON = work log, addr JSON = {to, mentions}, files JSON) with an FTS5 index, `cursors` (per agent per conversation delivery position), `memstate` (per agent per conversation: memory cursor time and notes hash), `promises`, `files`, `pending` (external agent inboxes). Large files live under `~/.orcie/files`, notes under `~/.orcie/memory`. Conversation ids: `room:<name>`, `dm:<agent>` (the user's DM), `dm:<a>+<b>` (agent-to-agent). Sequence numbers are per conversation; cross-conversation ordering uses timestamps.

## 4. Sessions and memory

**Short-term memory** is one Claude session per (agent, conversation) inside the container (`sessions.json`, resumed with `--resume`).

**Long-term memory** (`server/src/memory.ts`) spans all of an agent's conversations:
- **Journal**: every message of every conversation the agent takes part in, including its own replies. It is derived from stored history (rebuilt at startup, appended on every post), so it can never drift from the record.
- **Notes**: `MEMORY.md` per agent on the host (`~/.orcie/memory/<agent>/`), written by the agent with `remember`.
- **Per-turn block**: every container-agent turn is prefixed with "Long-term memory": the notes and open promises (when the conversation's session is new or they changed), **Possibly related** older messages from other conversations (keyword relevance), and **Meanwhile** messages from other conversations since this one was last looked at (25 max).
- **Tools** in every container: `remember`, `recall` (notes plus full history), `read_room`, `promise add|list|done|cancel`. All are scoped to the calling agent's own conversations.

Agents also keep their own free-form files in `/data/memory` (from onboarding); these are separate from the server-side notes.

## 5. Agent lifecycle (HR)

- **Hire**: `POST /agents` or the wizard. The wizard interviews the operator with a tool-less Claude call and drafts a profile (role, summary, instructions, skills, memory seed, tools, resources, greeting, plus **team, manager, responsibilities, description**), editable live; then the container starts (`runContainer`: volume, CPU/memory preset, subscription token, shared GitHub credential read-only, per-agent API token). Subscription auth only; Anthropic API keys are stripped from every environment.
- **Edit profile** after hiring: role header, skills, team/manager and memory seed apply immediately (the harness rewrites the role header of `CLAUDE.md`); tool and resource changes need `recreate`. Managers must exist and may not form loops.
- **Control**: Stop (cancels the running turn, clears the queue), Restart (container process), live **model change** (sent with every turn, no recreate), `recreate` (new container, same volume).
- **Startup**: any container agent whose container is missing or built from an older image is recreated on its volume.
- **Lay off**: needs the agent's name as confirmation; deletes container and volume, removes it from all rooms, archives its notes to `~/.orcie/memory/_retired/`; **all conversation history is kept**.

## 6. Message routing

A conversation's messages reach every agent member's session. Each (conversation, agent) has a serial worker; messages that arrive during a turn are batched into the next one (cursor-based). Details (`server/src/addressing.ts`, `route()` in `index.ts`):
- **Addressing**: from the human any named agent is *asked*; from agents only `@name` or a leading "name," / "name:" asks, other mentions are *mentioned in passing*; `@here`/everyone/each of you asks all. Saved on the message as `to` and `mentions`.
- **Who is woken**: a human message naming agents wakes only those; unaddressed human messages are heard by all; an agent message wakes only the agents it names. The rest catch up on their next turn. Every turn carries a note saying why the agent was woken.
- **Silence**: a reply that contains `NO_REPLY` is dropped; acknowledgement-only room replies are dropped.
- **Draft revision**: in rooms, a drafted reply is held if new messages arrive and reconsidered before posting.
- **Loop guard**: after 12 (room), 10 (agent DM) or 25 (user DM) agent messages in a row without the human, fan-out pauses with a visible "Paused fan-out" notice and resumes when the human posts (also for synchronous agent DMs). Computed from history.
- **Cross-conversation messaging**: `send_message "<user|#room|agent>" "<text>"` (async) and `orcie-dm <agent> "<text>"` (waits for the answer). Agent DMs remember the conversation they started from (`origin`, validated server-side) and the recipient is reminded to report back there.
- **Work log**: narration before the final answer is stored with the message and shown collapsed, with the tool calls.
- **Modes**: rooms default to parallel; a legacy sequential mode answers one agent at a time.

## 7. Harness

One HTTP service per container (`harness/src/index.ts`), every endpoint except `/healthz` requiring the agent's token. `/send` runs `claude -p --output-format stream-json --verbose --dangerously-skip-permissions --model <per-turn model> [--resume <session>]` with the prompt on stdin and streams tool events as NDJSON. The container runs as non-root, `HOME=/data/home`, with a HEALTHCHECK and `restart: unless-stopped`.

## 8. Live browser

Each agent's Playwright MCP drives a persistent headed Chromium on Xvfb inside its container (profile on the volume, so logins persist) through a CDP proxy (`harness/src/browser.ts`). x11vnc exposes it only on the container's loopback. The operator watches in a picture-in-picture panel: the server relays VNC over a WebSocket through `docker exec` (no port published; Origin, Host and loopback checked) to the vendored noVNC client, falling back to screenshots. **Take control** makes the proxy refuse the agent's input, navigation and tab actions until the operator **hands back** with an optional note; the operator can type text into the focused field. The agent asks for help with `browser_help "<why>"`, which notifies the UI and waits for the hand-back.

## 9. Files

Uploads (JSON/base64, 25 MB) are stored on the host and attached to messages; downloads are served as `application/octet-stream` attachments (inline only for known image types, with `nosniff` and a sandbox CSP). Agents fetch files attached in conversations they are in (`fetch_file`) and share their own into the current conversation (`share_file`).

## 10. Tmux bridge and external agents

`link-tmux` links a host Claude session as an agent: messages are typed into the pane (long text goes by file pointer); the reply and live tool activity come from the session's transcript under `~/.claude/projects`. Only explicitly linked sessions are touched; a deny list keeps the manager sessions out. External agents (Muse) poll an inbox over the private API; they never get a container or the GitHub token.

## 11. Muse alignment and upgrade path

From Muse: one long-running container per agent with its own volume and secrets, files and logs as the source of truth, large payloads by pointer, heartbeats for silent failures, human approval for dangerous operations (policy in the agent's `CLAUDE.md`). Orcie differs by being conversational (DMs and rooms with membership fan-out) rather than task dispatch by filename, and by adding cross-conversation memory. From the tmux setup: tmux session per agent, `send-keys`/`capture-pane`, and the file inbox are replaced by containers, the harness `/send` API and the server router; the tmux bridge covers sessions that must stay on the Mac.

## 12. Known gaps

Single operator; no UI login (loopback only). Agents share the Docker bridge network, and run as one trust domain (a malicious agent could try other containers' unauthenticated ports, none of which control agents any more). Fine-grained per-agent GitHub credentials, per-client private-API tokens, and push delivery to Muse are not built.
