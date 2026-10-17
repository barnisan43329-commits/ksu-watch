#!/usr/bin/env python3
"""
KsuNiMeet Watch — backend check.

Proves the five things the app depends on and nothing else:

  1. a room is created and read back;
  2. a film piece survives the round trip BYTE FOR BYTE (sha256), and a
     Cyrillic film name comes back as the same string;
  3. the snapshot keeps the millisecond position intact (not seconds, not
     rounded) and the sequence number only ever grows;
  4. a HELD wait answers in the same breath as the press — the latency that
     makes the mirror feel instant — measured over several presses;
  5. a wait that has nothing to say comes back empty after its timeout
     instead of holding the worker forever.

Usage:  python tools/test-api.py [base-url] [press-url]
        python tools/test-api.py http://127.0.0.1:8099
        python tools/test-api.py http://127.0.0.1:8099 http://127.0.0.1:8098

WHY A SECOND URL. The held-wait check needs one request parked inside the
server while another one arrives. PHP's built-in server is single-threaded on
Windows, so with one port the press would queue behind the wait and the test
would measure the queue, not the backend. Two instances on two ports share the
same data directory — which is also how two phones are served in reality — so
the wait parks on one and the press lands on the other.
"""

import hashlib
import json
import os
import sys
import threading
import time
import urllib.request
import urllib.error

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8099").rstrip("/")
PRESS = (sys.argv[2] if len(sys.argv) > 2 else BASE).rstrip("/")
FAIL = []
OK = []

# A Windows console is cp1252 and dies on the film name. The names ARE the
# thing under test, so fix the console rather than avoid printing them.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001 - an old Python just keeps the default
    pass


def check(name, good, note=""):
    (OK if good else FAIL).append(name)
    print(("  ok   " if good else "  FAIL ") + name + (("  " + note) if note else ""))


def call(path, method="GET", body=None, raw=False, timeout=30, base=None):
    url = (base or BASE) + path
    data = None
    headers = {}
    if body is not None:
        if isinstance(body, (bytes, bytearray)):
            data = bytes(body)
            headers["Content-Type"] = "application/octet-stream"
        else:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        payload = r.read()
    return payload if raw else json.loads(payload.decode("utf-8"))


def main():
    print("base:", BASE)

    health = call("/api/health")
    check("health says it is ours", health.get("name") == "ksu-watch", str(health))
    check("health reports a chunk size", health.get("maxChunk", 0) > 0)
    check("data directory writable", bool(health.get("writable")))

    room = call("/api/room", "POST")
    code = room.get("code", "")
    check("room created", len(code) == 6, code)

    # --- film transport -----------------------------------------------------
    NAME = "Фильм — Тест (2019).mp4"
    piece = os.urandom(1024 * 1024)
    call("/api/film?code=" + code, "POST",
         {"name": NAME, "size": len(piece), "parts": 1})
    call("/api/part?code=%s&idx=0" % code, "POST", piece)

    back = call("/api/part?code=%s&idx=0" % code, raw=True)
    same = hashlib.sha256(back).hexdigest() == hashlib.sha256(piece).hexdigest()
    check("piece returns byte for byte", same,
          "%d bytes" % len(back) if same else "size %d != %d" % (len(back), len(piece)))

    info = call("/api/room?code=" + code)
    film = info.get("film") or {}
    check("film name survives Cyrillic exactly", film.get("name") == NAME,
          repr(film.get("name")))
    check("film size survives", film.get("size") == len(piece))

    # --- snapshot -----------------------------------------------------------
    # 12 345 ms: seconds would still pass a loose test, milliseconds would not.
    T = 12345
    st = call("/api/state?code=" + code, "POST",
              {"t": T, "p": 0, "d": 7200000, "by": "tester", "a": "play"})
    snap = st["snap"]
    check("position keeps milliseconds", snap.get("t") == T, str(snap.get("t")))
    check("duration kept", snap.get("d") == 7200000)
    check("playing flag kept", snap.get("p") == 0)
    check("server stamped the snapshot", snap.get("at", 0) > 0)
    seq1 = snap.get("seq", 0)

    st2 = call("/api/state?code=" + code, "POST",
               {"t": 14000, "p": 1, "d": 7200000, "by": "tester", "a": "pause"})
    check("sequence only grows", st2["snap"]["seq"] == seq1 + 1,
          "%s -> %s" % (seq1, st2["snap"]["seq"]))

    # --- held wait: the latency that matters --------------------------------
    lat = []
    for i in range(5):
        after = st2["snap"]["seq"] + i
        box = {}

        def waiter():
            t0 = time.time()
            try:
                box["r"] = call("/api/wait?code=%s&after=%d&ms=6000" % (code, after))
            except Exception as e:  # noqa: BLE001 - reported, not swallowed
                box["err"] = repr(e)
            box["dt"] = time.time() - t0

        th = threading.Thread(target=waiter)
        th.start()
        time.sleep(0.25)           # the guest is parked in the wait by now
        sent = time.time()
        call("/api/state?code=" + code, "POST",
             {"t": 20000 + i, "p": 0, "d": 7200000, "by": "tester", "a": "seek"},
             base=PRESS)
        th.join(10)
        if "err" in box:
            check("wait round %d" % i, False, box["err"])
            continue
        r = box["r"]
        got = r["snap"]["t"]
        # How long the press took to become an answer. This is the number that
        # the whole app is built around: the button and the reaction are the
        # same event, not a poll apart.
        latency_ms = (time.time() - sent) * 1000.0
        lat.append(latency_ms)
        check("wait round %d delivered the new position" % i, got == 20000 + i,
              "t=%s" % got)

    if lat:
        print("  press -> answer: min %.0f ms, median %.0f ms, max %.0f ms"
              % (min(lat), sorted(lat)[len(lat) // 2], max(lat)))
        check("every press reached the waiting side under 250 ms",
              max(lat) < 250.0, "max %.0f ms" % max(lat))

    # --- empty wait comes back, does not hang -------------------------------
    last = call("/api/room?code=" + code)
    t0 = time.time()
    idle = call("/api/wait?code=%s&after=999999&ms=300" % code)
    took = time.time() - t0
    check("empty wait returns after its timeout", idle.get("idle") is True,
          "%.2fs" % took)
    check("empty wait did not outstay its cap", took < 2.0, "%.2fs" % took)

    print("\n%d passed, %d failed" % (len(OK), len(FAIL)))
    if FAIL:
        print("failed:", ", ".join(FAIL))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
