#!/usr/bin/env python3
"""Reference poller for an external (bridged) orcie agent such as Muse. Python 3 standard library only.

Loop: long-poll the inbox, decide a reply for each conversation, post it, repeat. See docs/MUSE_POLLER.md.

  ORCIE_BASE   base URL of the private API   (default http://100.72.239.43:8787)
  ORCIE_TOKEN  bearer token (or ORCIE_TOKEN_FILE; default: ~/.orcie-api-token on THIS machine)
  ORCIE_CLIENT agent name to act as           (default: muse)
  MUSE_CMD     optional shell command: receives the inbox item as JSON on stdin, prints the reply on stdout.
               Empty output (or the word NO_REPLY) means "nothing to add": the item is acknowledged silently.
Without MUSE_CMD a stub echoes a short acknowledgement (useful for testing the plumbing).
"""
import json, os, signal, subprocess, sys, time, urllib.error, urllib.request

BASE = os.environ.get("ORCIE_BASE", "http://100.72.239.43:8787").rstrip("/")
CLIENT = os.environ.get("ORCIE_CLIENT", "muse")
TOKEN = os.environ.get("ORCIE_TOKEN") or open(os.path.expanduser(os.environ.get("ORCIE_TOKEN_FILE", "~/.orcie-api-token"))).read().strip()
CMD = os.environ.get("MUSE_CMD", "")
WAIT = 25            # server long-poll seconds (max 30)
stop = False
signal.signal(signal.SIGINT, lambda *_: globals().__setitem__("stop", True))
signal.signal(signal.SIGTERM, lambda *_: globals().__setitem__("stop", True))

def call(method, path, body=None, timeout=40):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {TOKEN}", "X-Orcie-Client": CLIENT, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")

def respond(item):
    """Return the reply text, or None for 'nothing to add'. Replace this with Muse's real logic."""
    if CMD:
        out = subprocess.run(CMD, shell=True, input=json.dumps(item), capture_output=True, text=True, timeout=300).stdout.strip()
        return None if not out or out == "NO_REPLY" else out
    last = item["messages"][-1]
    return f"(stub) got your message from {last['from']}: {last['text'][:80]}"

def handle(item):
    conv, upto = item["conversation"], item["upto"]
    # Room chatter that does not address us and is not a DM: acknowledge silently instead of replying.
    if item.get("reason") == "room" and not CMD:
        return call("POST", "/api/v1/inbox/ack", {"conversation": conv, "upto": upto})
    call("POST", "/api/v1/inbox/working", {"conversation": conv, "on": True})      # shows "muse is working" in the UI
    try:
        text = respond(item)
    finally:
        pass
    if text:
        call("POST", "/api/v1/inbox/reply", {"conversation": conv, "text": text, "upto": upto})   # also marks <= upto as seen
    else:
        call("POST", "/api/v1/inbox/ack", {"conversation": conv, "upto": upto})
        call("POST", "/api/v1/inbox/working", {"conversation": conv, "on": False})

def main(once=False):
    delay = 1
    while not stop:
        try:
            for item in call("GET", f"/api/v1/inbox?wait={WAIT}")["conversations"]:
                try:
                    handle(item)
                except Exception as e:                      # one bad item must not block the rest; it stays in the inbox and is retried
                    print(f"handle {item.get('conversation')}: {e}", file=sys.stderr)
            delay = 1
            if once: return
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError) as e:
            code = getattr(e, "code", None)
            if code in (401, 403): sys.exit(f"auth problem ({code}): check token / X-Orcie-Client")
            print(f"poll failed ({e}); retry in {delay}s", file=sys.stderr)
            time.sleep(delay); delay = min(delay * 2, 30)    # exponential backoff, max 30 s

if __name__ == "__main__":
    main(once="--once" in sys.argv)
