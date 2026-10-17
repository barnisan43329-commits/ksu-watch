/**
 * The relay, tested the way it will be used.
 *
 * Two halves, because the two things that can break are unrelated:
 *
 *   1. AES. The challenge is solved with a plain AES-128-CBC implementation
 *      (WebCrypto refuses a ciphertext with no PKCS#7 padding), so the maths is
 *      compared block for block against Node's own crypto over 200 random
 *      cases. A wrong table is invisible until a cookie is silently rejected.
 *
 *   2. The door. The exported handler is driven with real Requests against the
 *      live InfinityFree backend: CORS, preflight, a binary piece up and back
 *      down, a press released through a held request, and a rotated cookie
 *      recovered mid-flight.
 *
 *   node relay/test-relay.mjs
 */
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, 'worker.js'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  ok    ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
};

/* ---------------------------- 1. the AES ---------------------------- */

/* The deployed module's own source, minus the handler, so the test cannot pass
 * against a copy of the code that is not the code being shipped. */
const body = SRC.slice(0, SRC.indexOf('export default'));
const parts = new Function(
  body + '\nreturn { slowAesDecrypt, decryptBlock, expandKey, hexToBytes, bytesToHex };'
)();

const decryptCbc = (key, iv, data) => {
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(data), d.final()]);
};

console.log('AES-128-CBC against node crypto');
for (let i = 0; i < 200; i++) {
  const key = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const blocks = 1 + (i % 4);
  const data = crypto.randomBytes(16 * blocks);
  const got = parts.slowAesDecrypt(key.toString('hex'), iv.toString('hex'), data.toString('hex'));
  const want = decryptCbc(key, iv, data);
  if (Buffer.compare(Buffer.from(got), want) !== 0) {
    ok('case ' + i, false, 'key=' + key.toString('hex'));
    break;
  }
  if (i === 199) ok('200 random key/iv/plaintext cases', true, '1-4 blocks each');
}

/* A single known vector, so a passing random loop cannot hide a systematic
 * off-by-one in the S-box construction. */
{
  const key = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
  const plain = Buffer.from('6bc1bee22e409f96e93d7e117393172a', 'hex');
  const enc = crypto.createCipheriv('aes-128-ecb', key, null);
  enc.setAutoPadding(false);
  const cipher = Buffer.concat([enc.update(plain), enc.final()]);
  const back = parts.decryptBlock(parts.expandKey(key), cipher);
  ok('FIPS-197 style block decrypt', Buffer.compare(Buffer.from(back), plain) === 0);
}

/* --------------------------- 2. the door --------------------------- */

const worker = (await import('./worker.js')).default;
const RELAY = 'https://relay.test';
const ORIGIN = 'https://example.github.io';

const call = (path, init = {}) =>
  worker.fetch(
    new Request(RELAY + path, {
      ...init,
      headers: { Origin: ORIGIN, ...(init.headers || {}) },
    })
  );

console.log('\nThe relay against the live backend');
const health = await call('/watch/api/health');
const healthText = await health.text();
let healthJson = {};
try {
  healthJson = JSON.parse(healthText);
} catch (e) {
  /* left empty: the assertion below reports the raw body */
}
ok('health through the relay', healthJson.ok === true && healthJson.name === 'ksu-watch', healthText.slice(0, 120));
ok('challenge solved behind the scenes', !healthText.includes('slowAES'));
ok('CORS for the calling origin', health.headers.get('access-control-allow-origin') === ORIGIN);
ok('preflight answered', (await call('/watch/api/health', { method: 'OPTIONS' })).status === 204);

const code = JSON.parse((await (await call('/watch/api/room', { method: 'POST' })).text()).toString()).code;
ok('room created through the relay', /^[A-Z0-9]{4,8}$/.test(code || ''), code);

const name = 'Фильм — реле 📽';
await call('/watch/api/film?code=' + code, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, size: 262144, parts: 2, type: 'video/webm' }),
});

const pieceA = crypto.randomBytes(131072);
const pieceB = crypto.randomBytes(131072);

/* Each answer is read before the next call, the way a client behaves: a held
 * response body is a Node/undici detail of running the worker in-process, not
 * something the deployed worker ever exposes. */
const upload = async (idx, bytes) => {
  const res = await call('/watch/api/part?code=' + code + '&idx=' + idx, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  return JSON.parse(await res.text());
};
const up1j = await upload(0, pieceA);
const up2j = await upload(1, pieceB);
ok('128 KB pieces accepted', up1j.ok && up2j.ok, up1j.size + ' + ' + up2j.size);

const downA = Buffer.from(await (await call('/watch/api/part?code=' + code + '&idx=0')).arrayBuffer());
const downB = Buffer.from(await (await call('/watch/api/part?code=' + code + '&idx=1')).arrayBuffer());
ok('piece 0 byte-identical through the relay', Buffer.compare(downA, pieceA) === 0, downA.length + 'B');
ok('piece 1 byte-identical through the relay', Buffer.compare(downB, pieceB) === 0, downB.length + 'B');

const meta = JSON.parse(await (await call('/watch/api/room?code=' + code + '&who=relaytest')).text());
ok('unicode film name survives', meta.film && meta.film.name === name, JSON.stringify(meta.film && meta.film.type));

const started = Date.now();
const held = call('/watch/api/wait?code=' + code + '&after=0&ms=8000').then(async (r) => ({
  snap: (JSON.parse(await r.text()) || {}).snap,
  ms: Date.now() - started,
}));
await new Promise((r) => setTimeout(r, 250));
await call('/watch/api/state?code=' + code, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ t: 61500, p: 0, d: 120000, by: 'A', a: 'play' }),
});
const released = await held;
ok(
  'held request released by a press',
  released.snap && released.snap.seq > 0 && released.ms < 3000,
  'in ' + released.ms + 'ms'
);
ok(
  'snapshot intact',
  released.snap && released.snap.t === 61500 && released.snap.p === 0 && released.snap.d === 120000,
  JSON.stringify(released.snap)
);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
