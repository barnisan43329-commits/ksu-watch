# Watch together — the backend

PHP 7.4+ (8.x fine). No database, no composer, no framework. A room is a
directory and a snapshot is one small JSON file, so this runs on any shared
host — including the free ones that give you one MySQL database you would
rather not spend on two people watching a film.

```
index.php        router + CORS
lib.php          rooms, atomic JSON, snapshot sequencing, sweep
config.php       chunk size, wait cap, room lifetime    ← the only knobs
api/room.php     create / read a room
api/film.php     film name + pieces up and down
api/sync.php     snapshot store and the held wait
data/            rooms live here — must be writable, must not be readable
tools/test-api.py  20 checks against a live backend
```

## Install (any cPanel/InfinityFree host)

1. Upload this folder's **contents** to `htdocs/` (so `htdocs/index.php`
   exists). Keep `data/` — the app writes rooms into it.
2. Make `data/` writable: `chmod 755 data` (or 775 if the host wants it).
   The `.htaccess` files inside refuse web access to it two different ways.
3. Open `https://your-site/api/health` — it must answer:

```json
{"ok":true,"name":"ksu-watch","maxChunk":8388608,"waitMs":8000,"writable":true}
```

If `writable` is `false`, nothing else will work: fix the permissions of
`data/` first.

4. Put that address into `web/config.js` (`backend`) and re-upload the page.

## InfinityFree, honestly

Three things about the free tier matter here, and two of them shaped the code:

- **The browser check.** Free InfinityFree sites answer non-browser clients with
  a JavaScript + cookie challenge instead of the page. This app is a browser —
  a WebView inside the APK runs JavaScript and keeps cookies — so it should
  pass, unlike a plain HTTP library. **I could not test this from here: there
  is no account on that host in this workspace.** If `api/health` opens in the
  phone's browser but the app says it cannot reach the server, that check is
  the reason, and the fix is a small paid plan or any ordinary PHP host.
- **10 MB per request.** A film piece is 8 MB for this reason (`KSU_CHUNK`).
  Nothing about 8 MB is visible to the viewer: the pieces are glued back into
  one blob on the receiving phone.
- **No cron, and a process limit.** Rooms are swept lazily (one request in
  forty deletes rooms older than 12 hours). A held sync request occupies one
  PHP process, so the hold is capped at 8 s (`KSU_WAIT_MS`) and the page falls
  back to plain polling by itself if the host kills held requests three times
  in a row. Latency then rises from tens of milliseconds to the poll interval —
  worse, but it keeps working.

## API

| | | |
|---|---|---|
| `GET` | `/api/health` | are we the right backend, what is the piece size |
| `POST` | `/api/room` | create a room → `{code}` |
| `GET` | `/api/room?code=&who=` | film, people, server time |
| `POST` | `/api/film?code=` | `{name,size,parts,type,chunk}` |
| `POST` | `/api/part?code=&idx=` | one piece, raw body |
| `GET` | `/api/part?code=&idx=` | the same bytes back |
| `POST` | `/api/state?code=` | `{t,p,d,by,a}` → `{snap}` |
| `GET` | `/api/wait?code=&after=&ms=` | HOLD until `seq > after` |

`snap` is the whole shared state: `{seq, t (ms), p (0/1), d (ms), at (server
ms), by, a}`. The server assigns `seq` — never a phone — so "apply this once"
holds even when two presses arrive out of order.

`at` is the server's millisecond when the snapshot was stored. The receiving
side adds `now - at` to the position while playing, so a packet that spent
80 ms in flight lands where the sender actually is. Phone clocks never enter
the calculation.

## Test

```bash
python tools/test-api.py http://127.0.0.1:8099 http://127.0.0.1:8098
```

Twenty checks: room creation, a film piece returning **byte for byte**, a
Cyrillic film name surviving exactly, milliseconds surviving the snapshot,
`seq` only growing, the held wait delivering a press **under 250 ms**, and an
empty wait returning after its timeout instead of hanging.

Two ports on purpose — PHP's built-in server is single-threaded on Windows, so
the waiting request parks on one instance while the press lands on the other.
Both share `data/`, which is also how two phones are served in reality.

Locally, run the backend with:

```bash
php -S 127.0.0.1:8099 index.php
```
