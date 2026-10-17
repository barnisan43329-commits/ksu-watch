# KsuNiMeet Watch — watch together, nothing else

| | |
|---|---|
| **the page (live)** | https://barnisan43329-commits.github.io/ksu-watch/ |
| **the PHP (live)** | https://ksunimeet.gt.tc/watch/api/health |
| **the door in front of it** | https://site-6d82979dc7d4471590b04884f411bb74.freebuff.page/watch/api/health |
| **the APK** | https://github.com/barnisan43329-commits/ksu-watch/releases/tag/v1.1 |
| **the repository** | https://github.com/barnisan43329-commits/ksu-watch |

The two backend addresses are the same PHP. The second one is a relay, and the
page uses it — see [the relay](relay/README.md) for the reason, which is one
sentence long: InfinityFree answers every request with a JavaScript challenge
that carries no `Access-Control-Allow-Origin`, so a page on another origin is
refused before it can read the answer, and the host will not turn that off.

If the page says *"the server at … is not answering"*, open the relay's
`/api/health` yourself. It must answer
`{"ok":true,"name":"ksu-watch",…,"writable":true}`.

Two people, one film, and the buttons in the middle. No chat, no calls, no
accounts, no server-side media.

```
CURRENT/
  web/            the page — GitHub Pages            (3 files + config.js)
  relay/          the door — solves the host's challenge, adds CORS
  php-backend/    the API — any PHP host             (InfinityFree and friends)
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

1. **Backend** — upload `php-backend/` to a PHP host, make `data/` writable,
   check `/api/health`. Details: [php-backend/README.md](php-backend/README.md).
2. **Page** — put that address into [`web/config.js`](web/config.js), push, and
   let the workflow publish `web/` to GitHub Pages.
   Details: [web/README.md](web/README.md).
3. **Relay** — `relay/` is already deployed; its address is what
   `web/config.js` points at. Replacing it is one file and one command:
   [relay/README.md](relay/README.md).
4. **APK** — `bash android-app/build.sh` → `android-app/KsuWatch.apk`.
   The page is bundled inside, so the app opens with no signal at all. If
   `config.js` was left empty it asks for the server address once on the first
   screen and keeps it on the phone — so the same APK works against any host.

## Using it

Host: **Create a room**, pick the film (it starts playing from the phone
immediately, the copy to the room runs in the background), send the link.

Guest: open the link, the film downloads by itself, the player appears.

Either side presses play, pause, or drags the bar. Both do the same thing at the
same millisecond.

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

- `php-backend/tools/test-api.py` — **20 / 20** against a local PHP.
  `relay/test-relay.mjs` re-runs the same ground against the **live** host —
  **13 / 13**: AES checked block for block against Node's `crypto` (200 random
  cases), CORS and preflight, a room, two 128 KB pieces up and back down
  byte-identical, a Cyrillic film name, a press released through a held request.
- `web/tools/test-mirror.mjs` — **17 / 17**, run against the **deployed relay**:
  the real `app.js` twice, one "phone" each. Pause mirrors to `120.000` on both
  sides; play after pause continues at `120.250` (never 0); a drag mirrors
  backwards exactly; nothing is published and no correction is applied during
  1.5 s of plain playback (drift 0.000 s).
- **The live page in a real browser** — room created, the player stage hidden
  behind the entry screen as it should be, the film uploaded and mirrored from a
  second client, no console errors.
- `android-app/KsuWatch.apk` — `versionCode 2 / 1.1`, signed with the project
  key `35ece4…4efa`, `zipalign -c -p 4` passes, `assets/www/*` present and
  carrying the relay address.

## What was NOT verified here

- **Two real phones.** No Android device here. The mirror is proven in Node
  against the real page and the live backend; the last step needs fingers.
- **The APK on a device.** It compiles, signs and aligns here, and its assets
  are checked, but nothing in this workspace can press its buttons.
- **Films larger than RAM.** The guest glues the pieces into one blob. That is
  fine for ordinary films and is the reason there is no seek-on-download
  streaming; a 4 GB file on a 3 GB phone will not work.
- **Long sessions on the free host.** The press → other-phone path measures
  ~280 ms through the relay, with occasional multi-second stalls when
  InfinityFree's shared PHP is busy. Nothing is lost (the snapshot carries a
  sequence number), but a press can feel slow at those moments.
