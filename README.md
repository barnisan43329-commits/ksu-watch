# KsuNiMeet Watch — watch together, nothing else

| | |
|---|---|
| **the app (live, the one to share)** | https://ksunimeet.gt.tc/watch/ |
| **the mirror** | https://barnisan43329-commits.github.io/ksu-watch/ |
| **the PHP** | https://ksunimeet.gt.tc/watch/api/health |
| **the door** (only the mirror needs it) | https://site-6d82979dc7d4471590b04884f411bb74.freebuff.page/watch/api/health |
| **the APK** | https://github.com/barnisan43329-commits/ksu-watch/releases/tag/v1.3 |
| **the repository** | https://github.com/barnisan43329-commits/ksu-watch |

**The first line is the app.** The page and the PHP are the same site there, so
nothing sits in between: no CORS, no relay, no third-party request allowance.
Open it, create a room, send the link. Two phones, either URL, works.

The mirror on GitHub Pages is the same five files. It is on another origin, so
it needs a door; when its doors are out of allowance it forwards itself to the
first line, room code included, and says nothing about servers. See
[the relay](relay/README.md) for why a door is needed at all — one sentence:
InfinityFree answers every request with a JavaScript challenge that carries no
`Access-Control-Allow-Origin`, and will not turn that off.

**There is no server field anywhere, and nothing to configure.** The page finds
its own backend and hops to the next one when one stops answering.

Two people, one film, and the buttons in the middle. No chat, no calls, no
accounts, no server-side media.

```
CURRENT/
  web/            the page — 4 files + 2 configs (mirror and same-origin)
  php-backend/    the API — any PHP host, and where the page can live too
  relay/          the door the mirror needs: challenge solved, CORS added
  deploy-host.sh  one command: API + page to the host, verified byte for byte
  android-app/    the same page in a WebView, as APK
  .github/        Pages deployment
```

The previous, full app (chat, calls, WebRTC) is untouched in `K+S-FULL-APP/`.

## What crosses the network, and what does not

| | |
|---|---|
| the film | **never while watching.** Each side has the file on its own phone |
| the film, once | uploaded in 8 MB pieces to the room, downloaded once by the other side |
| play / pause / drag | **only when touched** — one snapshot, delivered in tens of milliseconds |
| anything on a timer | **nothing.** Between presses the two players are not connected |

The consequence is the point: the picture cannot stutter because of the
network, because the network is not carrying the picture. And it cannot
"drift-correct" itself in the middle of a scene, because there is no drift
correction at all.

## Start

1. **Both at once** — `./deploy-host.sh`. It uploads the API *and* the page to
   the same folder on the host, so `/watch/` is the app and `/watch/api/*` is
   its own API. Nothing to type afterwards.
2. **The mirror** — push; the workflow publishes `web/` to GitHub Pages. Its
   [`config.js`](web/config.js) lists the doors and the fallback, and needs no
   editing to keep working.
3. **Relay** — only the mirror uses it; it is already deployed and replacing it
   is one file and one command: [relay/README.md](relay/README.md).
4. **APK** — `bash android-app/build.sh` → `android-app/KsuWatch.apk`.
   The app opens the same page from the host, so it needs no door either, and
   falls back to the bundled copy if there is no signal.

## Using it

Host: **Create a room**, pick the film (it starts playing from the phone
immediately, the copy to the room runs in the background), send the link.

Guest: open the link, the film downloads by itself, the player appears.

Either side presses play, pause, or drags the bar. Both do the same thing at the
same millisecond.

## How the button travels (and why it is instant)

Measured on the live host, same origin, real browser:

| | |
|---|---|
| a static stylesheet from the host | ~490 ms |
| `GET /api/health` | ~450 ms |
| **a press through the server** | **~530 ms** |
| **a press down the data channel** | **1-3 ms** |

The first two numbers are the point: a 4 KB CSS file costs the same as a PHP
call, so the delay is the wire to the host, not the code. A press does not need
to cross an ocean — it needs to reach one other phone.

So the two phones open a **WebRTC data channel** and presses go straight across
it. The server is used for one thing only: telling them where each other are (a
dozen SDP lines through `/api/sig`). Once the channel is up:

- the press is on the other phone in milliseconds, positions identical to the
  millisecond (measured: host `1.000287` · guest `1.000287`, press → guest
  `play` in **2 ms**);
- **no held requests run at all** — the page stops asking the server anything,
  which also removes the request cost that a long watch used to carry;
- the press is *also* POSTed, so a phone that joins later still lands in the
  right place.

If the channel cannot come up — symmetric NAT, a network that blocks
peer-to-peer — the offer goes unanswered, the link drops silently after a few
tries, and every press travels the old way through `/api/state` and `/api/wait`.
Same app, same behaviour, ~530 ms. The status line says which one you have:
*linked · presses are direct*, or nothing.

## How the mirror is kept exact

Every press stores **one complete snapshot** — position in milliseconds,
playing or not, duration — with a server-assigned sequence number and the
server's own timestamp. The other side replaces its idea of the film with that
snapshot, **once**, and does nothing else:

```
press          snapshot stored             other phone
─────          ───────────────             ───────────
pause  →  {seq 12, t 120000, p 1, at ..}  →  currentTime = 120.000 ; pause()
play   →  {seq 13, t 120000, p 0, at ..}  →  currentTime = 120.000 + flight ; play()
drag   →  {seq 14, t  40000, p 0, at ..}  →  currentTime =  40.000 + flight ; play()
```

Two rules make the difference between "mirrored" and "twitching":

1. **A backward jump needs a command that means "be here".** Dragging and
   joining may move the other side backwards without limit; play and pause may
   only by 3 s. Without this, one bad position reading inside a press sends the
   second phone to the beginning of the film — the exact failure this project
   exists to not have.
2. **Our own events are never republished.** Applying a snapshot fires
   `play`/`pause`/`seeked` locally; within 1.2 s of an apply they are ours and
   ignored. Otherwise the two phones hand the same press back and forth and the
   picture jumps on its own.

## What was verified here

- **The same-origin deployment in a real browser** — `https://ksunimeet.gt.tc/watch/`
  loads with no server field, creates a room (`NSTK96`), and the pick screen
  appears with no console error. That path has no relay in it at all.
- `php-backend/tools/test-api.py` — **20 / 20** against a local PHP.
  `relay/test-relay.mjs` re-runs the same ground against the **live** host —
  **18 / 18**: AES checked block for block against Node's `crypto` (200 random
  cases), CORS and preflight, a room, two 128 KB pieces up and back down
  byte-identical, a Cyrillic film name, a press released through a held request.
- **The data channel, between two real pages on the live site**: both linked,
  `pcState: connected`, 20 of 20 probes at **1 ms**, both sides stopped holding
  requests — then a real 3 s film: a `play` press on the host reached the guest
  in **2 ms**, film at `1.000287` on both. A `seek` and a second `play`
  followed in the same few milliseconds. Against the same host through the
  server, the same press measured **534 ms** (`web/tools/bench-latency.mjs`).
- `web/tools/test-mirror.mjs` — **23 / 23**, run against the **live PHP** (through
  `relay/local-door.mjs`, which runs the real relay in-process so the tests spend
  none of the deployed door's allowance): the real `app.js` twice, one "phone"
  each. Pause mirrors to `120.000` on both
  sides; play after pause continues at `120.250` (never 0); a drag mirrors
  backwards exactly; a press on the guest side moves the host too; nothing is
  published and no correction is applied during 1.5 s of plain playback (drift
  0.000 s).
- **The mirror forwarding itself** — `https://barnisan43329-commits.github.io/ksu-watch/?r=NSTK96`
  opened with no door left (the relay's daily allowance is spent) and landed on
  `https://ksunimeet.gt.tc/watch/?r=NSTK96`, joined the room and sat in
  "Waiting for the other person…". No message, no field, no press.
- **The live page in a real browser** — a room created on the deployed page, a
  3 s film recorded and picked by hand, uploaded (8 MB piece path, preflight and
  POST both 200), pulled by a second client that opened the join link, and a
  press on the guest's side that moved the host to `2.1 s`. No console errors.
- `android-app/KsuWatch.apk` — `versionCode 4 / 1.3`, signed with the project
  key `35ece4…4efa`, `zipalign -c -p 4` passes, five `assets/www/*` entries with
  forward-slash paths, and the bundled `app.js` carries the link code (checked
  inside the archive). It opens `https://ksunimeet.gt.tc/watch/` and falls back
  to the bundled copy when the main frame fails. The published asset is
  byte-identical to the build here (`sha256 285d0659…`). Two defects found while
  checking it: the page was loaded from `file://`, where a WebView refuses
  every `fetch` — it is now served from an https origin of the app's own out of
  `assets/www` — and aapt2 on Windows had written asset names with backslashes,
  which a device cannot look up (`build.sh` step 4 fixes that).

## What was NOT verified here

- **Two real phones.** No Android device here. The mirror is proven in Node
  against the real page and the live backend; the last step needs fingers.
- **The APK on a device.** It compiles, signs and aligns here, and its assets
  are checked, but nothing in this workspace can press its buttons.
- **Films larger than RAM.** The guest glues the pieces into one blob. That is
  fine for ordinary films and is the reason there is no seek-on-download
  streaming; a 4 GB file on a 3 GB phone will not work.
- **The mirror while the door's allowance is out.** Freebuff Sites allows 10,000
  requests a day per account and the door shares that; it was spent on testing
  during this work, so the mirror forwards itself to the host until 00:00 UTC.
  The host deployment is not affected at all.
- **Long sessions on the free host.** The press → other-phone path measures
  ~280 ms through the relay, with occasional multi-second stalls when
  InfinityFree's shared PHP is busy. Nothing is lost (the snapshot carries a
  sequence number), but a press can feel slow at those moments.
