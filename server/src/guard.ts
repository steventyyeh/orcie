// Request guard for the local UI/API listener, and sender identity for agent containers.
// The UI API can drive agents that run shell commands, so it only accepts requests from its own page on loopback:
//  - Host must be localhost:<port> or 127.0.0.1:<port> (blocks DNS rebinding)
//  - non-GET requests carry no Origin, or the server's own origin (blocks cross-site requests)
//  - non-GET requests are application/json (forces a CORS preflight that the server never answers)
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type GuardInput = { method?: string; host?: string; origin?: string; contentType?: string; hasBody?: boolean };
export function guard(port: number, r: GuardInput): { status: number; error: string } | null {
  const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
  if (!r.host || !hosts.includes(r.host)) return { status: 403, error: "forbidden host" };
  const m = (r.method ?? "GET").toUpperCase();
  if (m !== "GET" && m !== "HEAD") {
    if (r.origin !== undefined && !hosts.some((h) => r.origin === `http://${h}`)) return { status: 403, error: "forbidden origin" };
    if (!/^application\/json\b/i.test(r.contentType ?? "")) return { status: 415, error: "content-type must be application/json" };
  }
  return null;
}

// Per-agent identity: token = HMAC(server secret, agent name). The server derives who is calling from the token; the
// `from` field of a request is never trusted. Each container only receives its own token.
export function loadSecret(file: string): string {
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const s = randomBytes(32).toString("hex"); writeFileSync(file, s, { mode: 0o600 }); chmodSync(file, 0o600); return s;
}
export const agentToken = (secret: string, name: string) => createHmac("sha256", secret).update(`orcie-agent:${name}`).digest("hex");
export function identify(secret: string, names: string[], authorization?: string): string | null {
  const t = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1]; if (!t) return null;
  const tb = Buffer.from(t);
  let who: string | null = null;
  for (const n of names) { const eb = Buffer.from(agentToken(secret, n)); if (eb.length === tb.length && timingSafeEqual(eb, tb)) who = n; } // no early exit
  return who;
}
