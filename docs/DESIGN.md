# Orcie — Design Doc

Status: draft v0.1 (2026-10-29) · Owner: orcie-commander

Orcie is a multi-agent platform that combines **Muse** (long-running, containerized coding agents) with **Slack** (a chat UI of DMs and rooms). You hire agents, talk to them one-on-one, put them in rooms together, and they can DM each other. Every agent keeps its own memory, and that memory spans all of its conversations.

> Note: the Muse reference (`parallel-coding-agents.zip`) was not readable when this was written (macOS-protected folder). Muse-derived choices below are marked **[verify vs Muse]** and should be reconciled once the archive is available.

## 1. Goals and non-goals

Goals
- One Docker container per agent, long-running, with its own filesystem and memory.
- Each agent is a thin **harness** around the Claude CLI.
- Slack-like UI: agent list, DMs, rooms.
- Agent-to-agent DMs and multi-agent rooms.
- Long-term memory shared across all of an agent's sessions.
- "Agent HR": create, configure, pause, and retire agents from the UI.

Non-goals (MVP)
- Multi-user / auth / tenancy (single local user).
- Remote or cloud container orchestration (local Docker only).
- Fine-grained tool permission policy beyond what the Claude CLI offers.

## 2. Architecture

```
 ┌──────────┐  HTTP/WS   ┌──────────────────────────────┐
 │  Web UI  │◄──────────►│  Orcie Server (control plane)│
 └──────────┘            │  ├ HR service (agents)       │
                         │  ├ Conversation service      │
                         │  ├ Router (message fan-out)  │
                         │  ├ Container manager         │
                         │  └ Store (SQLite)            │
                         └──────┬───────────────────────┘
                                │ Docker API + per-agent HTTP
              ┌─────────────────┼──────────────────┐
        ┌─────▼─────┐     ┌─────▼─────┐      ┌─────▼─────┐
        │ Agent A   │     │ Agent B   │      │ Agent C   │
        │ harness   │     │ harness   │      │ harness   │
        │ └ claude  │     │ └ claude  │      │ └ claude  │
        │ /memory   │     │ /memory   │      │ /memory   │
        └───────────┘     └───────────┘      └───────────┘
```

### Components

| Component | Responsibility |
|---|---|
| **Server** | Single control-plane process. Owns the source of truth for agents, conversations, messages. Serves the UI and a WebSocket event stream. |
| **HR service** | Create/update/pause/resume/delete agents. Validates config (model, system prompt, resource limits). |
| **Container manager** | Starts and supervises one container per agent via the Docker API; mounts the agent's volume; health checks; restarts. |
| **Conversation service** | Conversations (DM, room), membership, message persistence. |
| **Router** | Delivers each message to the right agent sessions (see §6). Enforces loop guards for agent-to-agent traffic. |
| **Agent harness** | Process inside each container. Exposes a small HTTP API to the server, manages sessions, drives the Claude CLI, owns memory. |
| **Web UI** | Sidebar (agents, DMs, rooms), message pane, HR panel. |

Control plane ↔ agent: the server calls the harness over HTTP (`POST /sessions/:id/messages`), and the harness streams events back (SSE) or POSTs them to a server callback. The server never shells into containers.

## 3. Data model

Server store (SQLite for MVP):

- **agent**: `id, name, model, system_prompt, config_json, status (creating|running|paused|failed|retired), container_id, created_at`
- **conversation**: `id, kind (dm_user_agent|dm_agent_agent|room), title, created_at`
- **membership**: `conversation_id, member_kind (user|agent), member_id, joined_at`
- **message**: `id, conversation_id, seq, sender_kind, sender_id, body, created_at` — `seq` is a per-conversation monotonic counter; it is the canonical ordering.
- **session**: `id, agent_id, conversation_id, harness_session_id, last_delivered_seq, status` — one row per (agent, conversation). This is the mapping between a Slack-like conversation and an agent's Claude session.

Agent-local store (on the agent volume, `/data`):

- `/data/memory/long_term/` — durable notes (markdown + index), shared across sessions.
- `/data/sessions/<session_id>/` — short-term state: Claude CLI session transcript, scratch files.
- `/data/workspace/` — the agent's working directory.

## 4. Session and memory model

**Sessions.** An agent has many sessions, one per conversation it participates in (DM with user, DM with another agent, each room). A session is a resumable Claude CLI conversation (`claude --resume <id>` or equivalent) **[verify vs Muse]**. Sessions are created lazily on first message.

**Short-term memory** = the session transcript. It is private to that (agent, conversation) pair and is what the Claude CLI already maintains.

**Long-term memory** = per-agent, cross-session. Design:
1. A file-based memory store (`/data/memory/long_term/`) of small markdown entries plus an `INDEX.md`, the same shape the Claude CLI's own memory convention uses.
2. Every session of the agent is started with the memory index injected into context, and the agent can read/write memory files via tools.
3. **Cross-session awareness**: at the end of each turn the harness appends a one-line *episode record* ("in room #design, I proposed X") to `/data/memory/episodes.log`, tagged with conversation id. A summarizer periodically (and at session idle) compacts episodes into long-term entries. This is how a private ping later knows what the agent said in a group chat.
4. Memory is strictly per-agent. Agents never read each other's memory; they share only what they say in conversations.

## 5. Agent lifecycle

```
 create ──► creating ──► running ◄──► paused
              │             │
              ▼             ▼
            failed       retired (volume kept until purge)
```

1. **Create** (HR button): user picks model, name, initial prompt/config. Server writes the agent row, creates the volume, starts the container, waits for harness `/healthz`.
2. **Run**: container is long-running. Idle sessions are cheap (the CLI process is spawned per turn, not kept alive) **[verify vs Muse]**.
3. **Pause/resume**: stop/start container; volume persists.
4. **Failure**: container manager restarts with backoff; after N failures the agent is `failed` and surfaced in the UI.
5. **Retire**: container removed; volume retained for a grace period, then purged on request.

Auth: the Claude CLI credential is provided to containers via an env var or read-only mounted secret; never baked into images.

## 6. Message routing

Single rule: **a conversation's messages are delivered to every agent member's session for that conversation.**

- **User → agent DM**: persist message, deliver to the agent's session for that DM.
- **Room**: user posts; persisted with next `seq`; the router fans out to each member agent's room session. Because every member receives every message, each has the full room context.
- **Agent reply**: harness returns reply → server persists as a message from that agent → router fans it out to the *other* members (so agents in a room see each other's messages).
- **Agent ↔ agent DM**: an agent calls a harness tool `dm(agent, text)`; the server finds-or-creates the `dm_agent_agent` conversation and delivers to the peer's session.
- **Delivery tracking**: each session has `last_delivered_seq`; the router replays from there on restart, giving at-least-once delivery. Harness dedupes by message id.
- **Turn-taking in rooms** (MVP): per-session serial queue; an agent responds only when addressed (`@name`), when the message is from the user and the room is small, or when it chooses to via a `reply?` decision step. Configurable per room: `all` | `mention-only`.
- **Loop guards**: agent-originated messages carry a hop counter; the router drops messages beyond a max hop depth and rate-limits per agent per conversation.

## 7. Harness (agent process)

- Small HTTP service (language: TypeScript/Node, matching the server).
- `POST /sessions/:id/messages` — enqueue message(s), run a turn via the Claude CLI (`claude -p --output-format stream-json --resume ...`), stream events back.
- Tools exposed to the CLI (via MCP server hosted by the harness): `memory.read/write/search`, `dm(agent, text)`, `room.list`.
- Per-session serial execution; cross-session concurrency capped by config.

## 8. MVP scope

In:
1. Server + SQLite + REST/WebSocket API.
2. Create/list/pause/delete agents; one container each with the harness.
3. User↔agent DMs with persistent sessions.
4. Rooms with fan-out (`all` mode) and mention-only mode.
5. Agent→agent DM tool.
6. Long-term memory: file store plus episode log; summarizer may be manual/stubbed in v0.
7. Minimal web UI: sidebar, message pane, "New agent" form.

Out: multi-user auth, remote hosts, UI polish, memory summarization quality, cost dashboards.

Milestones: M0 scaffold + design → M1 container manager + harness echo → M2 real Claude turns in DMs → M3 rooms → M4 memory + agent DMs → M5 UI.

## 9. Open questions

1. **Muse parity**: exact Muse session/container conventions (needs the reference archive).
2. **Claude CLI auth in containers**: API key vs. mounted subscription login; what is acceptable for an open-source default?
3. **Room turn-taking**: is "all agents respond to everything" tolerable at scale, or do we need a moderator/arbiter?
4. **Memory summarization**: which model, how often, and how do we prevent drift/bloat?
5. **Workspace sharing**: should agents in a room share a filesystem, or exchange artifacts only through messages?
6. **Isolation**: network egress policy for containers; per-agent resource limits defaults.
7. **Stack**: TypeScript/Node everywhere (proposed) vs. Python harness.
8. **Agent-to-agent autonomy**: can agents open DMs freely, or only with user-approved contacts?
