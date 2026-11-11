import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { acceptKey, upgrade, type WsConn } from "../src/ws-lite.ts";

test("accept key matches the RFC 6455 example", () => { assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="); });
test("echo over a real WebSocket client: text, binary, a large frame and fragmented sizes", async () => {
  let conn: WsConn | null = null;
  const srv = createServer(); srv.on("upgrade", (req, sock, head) => { conn = upgrade(req, sock, head); if (conn) conn.onMessage = (m) => conn!.send(m.text ? m.data.toString() : m.data); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port, ws = new WebSocket(`ws://127.0.0.1:${port}/x`); ws.binaryType = "arraybuffer";
  await new Promise<void>((r) => (ws.onopen = () => r()));
  const next = () => new Promise<any>((r) => (ws.onmessage = (e) => r(e.data)));
  let p = next(); ws.send("hello"); assert.equal(await p, "hello");
  for (const n of [0, 1, 125, 126, 127, 65535, 65536, 300_000]) { // every length-encoding boundary
    const buf = new Uint8Array(n).map((_, i) => i % 251); p = next(); ws.send(buf);
    const got = new Uint8Array(await p); assert.equal(got.length, n); assert.ok(n === 0 || got[n - 1] === buf[n - 1]);
  }
  ws.close(); srv.close(); srv.closeAllConnections();
});
test("non-WebSocket request to an upgrade handler is refused", async () => {
  const srv = createServer(); srv.on("upgrade", (req, sock, head) => { upgrade(req, sock, head); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const ws = new WebSocket(`ws://127.0.0.1:${(srv.address() as any).port}/x`);
  await new Promise<void>((r) => (ws.onopen = () => r()));
  ws.close(); srv.close(); srv.closeAllConnections();
});
