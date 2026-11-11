// Minimal RFC 6455 server side (no dependency): handshake plus text/binary framing, enough to relay VNC (binary) and CDP (text).
// Kept identical in server/src/ws-lite.ts and harness/src/ws-lite.ts (they ship in different images).
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const acceptKey = (key: string) => createHash("sha1").update(key + GUID).digest("base64");

export type WsMsg = { data: Buffer; text: boolean };
export class WsConn {
  private buf = Buffer.alloc(0); private frag: Buffer[] = []; private fragText = false; closed = false;
  onMessage: (m: WsMsg) => void = () => {}; onClose: () => void = () => {};
  private sock: Duplex;
  constructor(sock: Duplex, head: Buffer) {
    this.sock = sock;
    sock.on("data", (d: Buffer) => this.feed(d)); sock.on("close", () => this.end()); sock.on("error", () => this.end());
    if (head?.length) this.feed(head);
  }
  private end() { if (this.closed) return; this.closed = true; this.onClose(); }
  private feed(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80); let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 64 * 1024 * 1024) return void this.close();
      if (b.length < off + (masked ? 4 : 0) + len) return;
      let payload = b.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len);
      if (masked) { const k = b.subarray(off, off + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= k[i & 3]; }
      this.buf = b.subarray(off + (masked ? 4 : 0) + len);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this.frame(0xa, payload); continue; }   // ping -> pong
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2) { this.frag = [payload]; this.fragText = op === 0x1; } else if (op === 0x0) this.frag.push(payload);
      if (fin) { const data = Buffer.concat(this.frag); this.frag = []; this.onMessage({ data, text: this.fragText }); }
    }
  }
  private frame(op: number, payload: Buffer) {
    if (this.closed) return;
    const n = payload.length, head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
    this.sock.write(Buffer.concat([head, payload]));
  }
  send(data: Buffer | string) { typeof data === "string" ? this.frame(0x1, Buffer.from(data)) : this.frame(0x2, data); }
  close() { if (this.closed) return; try { this.frame(0x8, Buffer.alloc(0)); this.sock.end(); } catch { /* gone */ } this.end(); }
}

/** Completes the upgrade handshake; returns null (after writing an error) if the request is not a WebSocket upgrade. */
export function upgrade(req: IncomingMessage, sock: Duplex, head: Buffer): WsConn | null {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || String(req.headers.upgrade).toLowerCase() !== "websocket") { sock.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return null; }
  const proto = String(req.headers["sec-websocket-protocol"] ?? "").split(",")[0].trim(); // noVNC offers "binary"
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n${proto ? `Sec-WebSocket-Protocol: ${proto}\r\n` : ""}\r\n`);
  return new WsConn(sock, head);
}
