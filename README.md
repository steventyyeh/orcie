# orcie

A multi-agent platform combining Muse and Slack: Dockerized Claude-CLI agents with per-agent long-term memory, DMs, agent-to-agent DMs, and rooms.

Status: early scaffold. See [docs/DESIGN.md](docs/DESIGN.md).

- `server/`: control plane (agents, conversations, routing)
- `harness/`: process inside each agent container
- `web/`: UI (placeholder)

Dev: `node --experimental-strip-types server/src/index.ts`
