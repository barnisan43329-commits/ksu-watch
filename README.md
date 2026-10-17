# KsuNiMeet Watch — watch together, nothing else

| | |
|---|---|
| **the page (live)** | https://barnisan43329-commits.github.io/ksu-watch/ |
| **the backend (live)** | https://ksunimeet.great-site.net/watch/api/health |
| **the APK** | https://github.com/barnisan43329-commits/ksu-watch/releases/tag/v1.0 |
| **the repository** | https://github.com/barnisan43329-commits/ksu-watch |

If the page says *"the server at … is not answering"*, the backend is not up:
open that address yourself. It must answer `{"ok":true,"name":"ksu-watch",…}`.
Everything else on this page is already deployed and needs no rebuild.

Two people, one film, and the buttons in the middle. No chat, no calls, no
accounts, no server-side media.

```
CURRENT/
  web/            the page — GitHub Pages            (3 files + config.js)
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
3. **APK** — `bash android-app/build.sh` → `android-app/KsuWatch.apk`.
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

- `php-backend/tools/test-api.py` — **20 / 20**: piece returns byte for byte
  (sha256), Cyrillic film name survives exactly, milliseconds survive the
  snapshot, `seq` only grows, held wait answers a press in **14–17 ms**, empty
  wait returns on time.
- `web/tools/test-mirror.mjs` — **15 / 15**: runs the real `app.js` twice against
  a real backend, one "phone" each. Pause mirrors to `120.000` on both sides;
  play after pause continues at `120.300` (never 0); two presses in a row behave
  the same; a drag mirrors backwards exactly; nothing is published and no
  correction is applied during 1.5 s of plain playback (drift 0.000 s).
- `android-app/KsuWatch.apk` — `versionCode 1 / 1.0`, signed with the project
  key `35ece4…4efa`, `zipalign -c -p 4` passes, `assets/www/*` present.

## What was NOT verified here

- **InfinityFree's browser check.** The free tier answers non-browser clients
  with a JavaScript challenge. This app is a browser, so it should pass, but
  there is no account on that host in this workspace and I did not test it.
- **Two real phones.** No Android device here. The mirror is proven in Node
  against the real page and the real API; the last step needs fingers.
- **Films larger than RAM.** The guest glues the pieces into one blob. That is
  fine for ordinary films and is the reason there is no seek-on-download
  streaming; a 4 GB file on a 3 GB phone will not work.
