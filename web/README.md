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

## Two configurations, one page

| file | where it is used |
|---|---|
| `config.js` | the mirror on GitHub Pages: a list of `doors` and a `fallback` |
| `config.host.js` | uploaded as `config.js` by `../deploy-host.sh`, for the copy served BY the PHP host: `doors: []` — this very origin |

**Nothing in either is asked of a person.** There is no server field on the page
and no code path that reveals one.

A **door** is a base URL in front of the same PHP. The page probes every door in
parallel at load, keeps the fastest that answers, remembers it for next time, and
hops to another the moment one stops — a 429, a 5xx, a dead socket. A door that
answers 429 goes to sleep for two minutes instead of being hammered on every
press. `''` is a door too: it means *this very origin*, and it is always last.

The mirror needs a door because it is on another origin: InfinityFree wraps
every response in a JavaScript challenge with no `Access-Control-Allow-Origin`,
so the page is refused before it can read the answer. [Why, in full](../relay/README.md).

The copy served by the host needs no door at all — the page and the API are the
same site — and when every door of the mirror is out, the mirror forwards itself
there, room code included (`fallback`), instead of showing an error.

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
# the real relay and the real PHP, in-process, no platform allowance spent:
node ../relay/local-door.mjs 8096 8097 &
node tools/test-mirror.mjs http://127.0.0.1:8096/watch http://127.0.0.1:8097/watch
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
