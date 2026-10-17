# Watch together — the page

Three files and a config. No build step, no dependency, no framework.

```
index.html   the screen
style.css    the look
app.js       everything: room, upload, download, player, sync
config.js    WHERE THE BACKEND IS  ← the only file to edit
icon.svg     favicon
tools/       tests (not used by the page)
```

Deployed to GitHub Pages by `.github/workflows/pages.yml`, which publishes this
folder as-is whenever `CURRENT/web/**` changes on `main`.

## Before the first deploy

Edit `config.js`:

```js
window.KSU_CONFIG = { backend: "https://your-relay/watch" };
```

No trailing slash, no `/api` — the page adds that itself.

It points at the **relay**, not straight at the PHP: InfinityFree answers every
request with a JavaScript anti-bot challenge that carries no CORS header, so a
page on GitHub Pages is refused before it can read the answer. The relay solves
that challenge server-side and forwards the call — the PHP still does all of
the work. [Why, in full](../relay/README.md).

If it is left empty, the page asks for the address once on the entry screen and
keeps it on the phone. That is what the APK relies on: it is built from this
same folder, and a film app cannot ship with somebody else's server baked in.

## How it works, in one paragraph

The host picks a file; it plays from that file immediately through a blob URL,
so nothing waits for a network. In the background the file is cut into 8 MB
pieces and POSTed to the backend. The guest downloads the same pieces, glues
them back into one blob, and plays that. Between presses the two players are
not connected at all: no polling for position, no playback-rate correction, no
drift loop. A press — on either side — publishes one snapshot (position in ms,
playing or not, duration) and the other side applies it exactly once.

Both sides sit in a held request (`/api/wait`), so a press reaches the other
player in the same moment the server stores it: no timer, no polling interval.

## The two rules that keep it from twitching

1. **A jump backwards is only allowed for a command that means "be here"** — a
   drag (`seek`) or joining (`hello`). A `play`/`pause` may move the other side
   forward freely, but backwards only by 3 s. Without this, one bad position
   reading in a press sends the second phone to the beginning of the film.
2. **Our own events are not republished.** Applying a snapshot fires
   `play`/`pause`/`seeked` on the local element; within 1.2 s of an apply those
   are ignored. Without this the two phones pass the same press back and forth
   and the picture jumps on its own.

## Test

Two "phones" in one Node process, running this very `app.js` against a real
backend:

```bash
node tools/test-mirror.mjs http://127.0.0.1:8098 http://127.0.0.1:8099
```

Two ports because PHP's built-in server is single-threaded on Windows: a phone
parked in a held wait would otherwise block the other phone's press and the
test would measure the queue instead of the app.

`?debug=1` on any page exposes `window.__ksu` (state, `apply`, `push`,
`hostPick`) so a browser tab can be driven by hand.

## Using it

- Host: **Create a room** → pick a video → **Copy link** and send it.
- Guest: open the link (or type the code) → the film downloads by itself → the
  player appears.
- Either side may press play / pause / drag the bar. Both mirror.
