# The relay — the door in front of the PHP

```
the page (GitHub Pages)  ──►  this worker  ──►  https://ksunimeet.gt.tc/watch  (PHP)
```

| | |
|---|---|
| **live** | https://site-6d82979dc7d4471590b04884f411bb74.freebuff.page/watch |
| **health through it** | https://site-6d82979dc7d4471590b04884f411bb74.freebuff.page/watch/api/health |
| **source** | [`worker.js`](worker.js) — 330 lines, no dependencies |
| **test** | `node relay/test-relay.mjs` |

## Why it exists

InfinityFree wraps **every** response from a free-hosting account in a
JavaScript anti-bot challenge: a page that loads `/aes.js`, computes a `__test`
cookie with slowAES, then reloads the same URL. A browser solves that by
itself — but only when it may set a cookie for that domain and read the
answer. A page on GitHub Pages cannot: the challenge carries **no**
`Access-Control-Allow-Origin`, so the fetch is refused before a line of our
JavaScript sees it.

```
Access to fetch at 'https://ksunimeet.gt.tc/watch/api/health' from origin
'https://barnisan43329-commits.github.io' has been blocked by CORS policy:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

InfinityFree's own documentation says cross-origin AJAX is not available on free
hosting and that the security system cannot be disabled. So the one thing that
was missing was a party that *is* allowed to pass the challenge — a server. That
is this worker, and it does two things and nothing else:

1. **Solves the challenge once**, server-side, and keeps the cookie. The
   challenge is AES-128-CBC: `__test = slowAES.decrypt(c, 2, a, b)`, which is
   one plaintext block XORed back with the IV. `worker.js` carries a plain AES
   implementation because WebCrypto insists on PKCS#7 padding and this
   ciphertext has none.
2. **Answers the page with CORS headers**, so any origin may call it.

The path is mirrored unchanged — `<relay>/watch/api/health` becomes
`https://ksunimeet.gt.tc/watch/api/health` — and bodies pass through byte for
byte, because the guest compares the film pieces to what the host sent.

It is a door, not a second backend. Rooms, snapshots, pieces and the held wait
all still run in PHP on InfinityFree.

## What it costs

| | |
|---|---|
| press → other side notified | **~280 ms** through the relay (was 3–16 ms against a local PHP) |
| a held wait | 7 s, the app's own cap, passed straight through |
| a film piece | 8 MB, buffered, `CONTENT_LENGTH` preserved |
| storage | nothing on the relay — it holds no state but one cookie |

The extra hop is real: the press crosses the planet twice and lands on a free
shared host. What it does *not* do is touch the picture — the film still never
crosses the network while it plays.

## Test

```bash
node relay/test-relay.mjs
```

Two halves, because two unrelated things can break:

- **the maths** — 200 random key/IV/plaintext cases plus a fixed AES block,
  compared block for block against Node's own `crypto`. A wrong table would be
  invisible until a cookie was silently rejected;
- **the door** — the exported handler is driven with real `Request`s against the
  live backend: CORS and preflight, a room, two 128 KB pieces up and back down
  byte-identical, a Cyrillic film name, and a press released through a held
  request.

Current result: **13 / 13 pass**.

## Deploy

The worker ships as an ES module with no dependencies:

```bash
# from CURRENT/, with the manifest at relay/site.json
sites_deploy  site e7e08216-8393-4ea8-b20e-8d68630a3163
```

`site.json` names `worker.js` as `index.js`; there are no assets. After a deploy
the page needs nothing: `web/config.js` already points at the production relay.

## If the host rotates its keys

It does. The constants in the challenge change, and a cookie that was valid five
minutes ago comes back as the challenge page. `worker.js` handles that in one
place: any response that arrives as HTML where JSON was expected is treated as a
rotated key — the cookie is dropped, solved again, and the request is replayed
**once** with the same body. A second failure is reported, never looped.
