// Agent-facing listener. Containers reach it as host.docker.internal:<port>; every call is authenticated with the
// calling agent's own token and the sender is taken from that token (never from the request body).
import { createServer } from "node:http";
import { identify } from "./guard.ts";

export type AgentApiCtx = {
  port: number; host: string; secret: string; agentNames(): string[];
  dm(from: string, to: string, text: string, origin?: string): Promise<string | null>;
  extra?(who: string, method: string, url: string, body: any, origin?: string): Promise<{ code: number; body: unknown } | null>; // later endpoints (memory tools etc.)
};
export function startAgentApi(ctx: AgentApiCtx) {
  return createServer(async (req, res) => {
    const json = (code: number, b: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    try {
      const who = identify(ctx.secret, ctx.agentNames(), req.headers.authorization);
      if (!who) return json(401, { error: "unknown agent token" });
      let raw = ""; for await (const c of req) { raw += c; if (raw.length > 40_000_000) return json(413, { error: "too large" }); }
      const b = raw ? JSON.parse(raw) : {}, url = (req.url ?? "").split("?")[0], origin = typeof req.headers["x-orcie-conversation"] === "string" ? req.headers["x-orcie-conversation"] : undefined; // which conversation the calling turn belongs to
      if (req.method === "POST" && url === "/dm") {
        if (typeof b.to !== "string" || typeof b.text !== "string" || !b.text.trim()) return json(400, { error: "to and text required" });
        if (b.to === who) return json(400, { error: "cannot message yourself" });
        return json(200, { from: who, reply: await ctx.dm(who, b.to, b.text, origin) }); // `from` in the body is ignored
      }
      const x = await ctx.extra?.(who, req.method ?? "GET", url, b, origin);
      if (x) return json(x.code, x.body);
      json(404, { error: "not found" });
    } catch (e) { json(400, { error: String(e).slice(0, 300) }); }
  }).listen(ctx.port, ctx.host);
}
