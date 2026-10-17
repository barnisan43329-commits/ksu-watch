/**
 * KsuNiMeet Watch — relay.
 *
 * language: JavaScript, runtime: Cloudflare Worker (ES module), target: InfinityFree PHP backend
 *
 * WHY THIS EXISTS
 *
 * InfinityFree wraps every response from a free-hosting account in a JavaScript
 * anti-bot challenge: a page that loads /aes.js, computes a `__test` cookie with
 * slowAES and reloads the same URL. A browser solves it by itself — but only when
 * it is allowed to set a cookie for that domain. A page on GitHub Pages (or a
 * WebView loading local assets) cannot: the challenge page carries no
 * `Access-Control-Allow-Origin`, so the fetch is rejected before any JavaScript
 * of ours sees it. InfinityFree documents cross-origin AJAX as unsupported on
 * free hosting and there is no switch to turn the check off.
 *
 * So this worker sits in the middle and does two things, nothing else:
 *
 *   1. It solves the challenge the same way the browser would, once, and keeps
 *      the cookie. The challenge is AES-128-CBC: `__test` is
 *      slowAES.decrypt(c, 2, a, b) — one plaintext block, XORed back with the IV.
 *      AES here is a plain implementation because WebCrypto insists on PKCS#7
 *      padding and this ciphertext has none.
 *
 *   2. It answers the browser with CORS headers, so any origin may call it.
 *
 * The path is mirrored unchanged: a request to <relay>/watch/api/health becomes
 * https://ksunimeet.gt.tc/watch/api/health. Nothing is rewritten, nothing is
 * cached, bodies pass through byte for byte — the film pieces are binary and
 * the guest compares them to what the host sent.
 *
 * The PHP still does all of the work. This is a door, not a second backend.
 */

const ORIGIN = 'https://ksunimeet.gt.tc';

/* A browser-shaped request. The challenge is keyed to look like a bot otherwise. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* The solved cookie lives in the isolate, not on the client. Workers are
 * recycled without warning, so a miss only costs one extra round trip. */
let solved = { value: '', until: 0 };

/* ============================ AES-128-CBC ============================ */

const mul = (a, b) => {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p & 0xff;
};

const rotl8 = (x, n) => ((x << n) | (x >> (8 - n))) & 0xff;

/* The S-box is derived, not transcribed: one typo in a 256-entry table is a
 * cookie that is silently wrong, and that failure looks exactly like a network
 * problem. Deriving it means it cannot be mis-typed. */
const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
{
  const inv = new Uint8Array(256);
  for (let x = 1; x < 256; x++) {
    let r = 1;
    for (let i = 0; i < 254; i++) r = mul(r, x);
    inv[x] = r;
  }
  for (let x = 0; x < 256; x++) {
    const b = inv[x];
    const s = b ^ rotl8(b, 1) ^ rotl8(b, 2) ^ rotl8(b, 3) ^ rotl8(b, 4) ^ 0x63;
    SBOX[x] = s;
    INV_SBOX[s] = x;
  }
}

/* Key schedule for 128-bit keys: 11 round keys of 16 bytes. */
function expandKey(key) {
  const w = new Uint8Array(176);
  w.set(key);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4];
    let t1 = w[i - 3];
    let t2 = w[i - 2];
    let t3 = w[i - 1];
    if (i % 16 === 0) {
      const tmp = t0;
      t0 = SBOX[t1] ^ rcon;
      t1 = SBOX[t2];
      t2 = SBOX[t3];
      t3 = SBOX[tmp];
      rcon = mul(rcon, 2);
    }
    w[i] = w[i - 16] ^ t0;
    w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2;
    w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}

/* One block, decrypted. State is column-major: state[c*4+r]. */
function decryptBlock(rk, input) {
  const s = new Uint8Array(input);
  const addKey = (round) => {
    for (let i = 0; i < 16; i++) s[i] ^= rk[round * 16 + i];
  };
  /* Inverse of "row r moves left by r": row r moves right by r. */
  const invShiftRows = () => {
    const t = new Uint8Array(s);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        s[c * 4 + r] = t[((c - r + 4) % 4) * 4 + r];
      }
    }
  };
  const invSubBytes = () => {
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
  };
  const invMixColumns = () => {
    for (let c = 0; c < 4; c++) {
      const a0 = s[c * 4];
      const a1 = s[c * 4 + 1];
      const a2 = s[c * 4 + 2];
      const a3 = s[c * 4 + 3];
      s[c * 4] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
      s[c * 4 + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
      s[c * 4 + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
      s[c * 4 + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
    }
  };

  addKey(10);
  for (let round = 9; round >= 1; round--) {
    invShiftRows();
    invSubBytes();
    addKey(round);
    invMixColumns();
  }
  invShiftRows();
  invSubBytes();
  addKey(0);
  return s;
}

const hexToBytes = (hex) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};

const bytesToHex = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
};

/* slowAES.decrypt(c, 2, a, b): mode 2 is CBC, `a` is the key, `b` the IV. */
function slowAesDecrypt(keyHex, ivHex, dataHex) {
  const rk = expandKey(hexToBytes(keyHex));
  const iv = hexToBytes(ivHex);
  const data = hexToBytes(dataHex);
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let off = 0; off < data.length; off += 16) {
    const block = data.subarray(off, off + 16);
    const plain = decryptBlock(rk, block);
    for (let i = 0; i < 16; i++) out[off + i] = plain[i] ^ prev[i];
    prev = block;
  }
  return out;
}

/* ============================ challenge ============================ */

const AES_RE = /a=toNumbers\("([0-9a-f]+)"\),b=toNumbers\("([0-9a-f]+)"\),c=toNumbers\("([0-9a-f]+)"\)/;

const isChallenge = (text) => typeof text === 'string' && text.indexOf('slowAES') !== -1;

/**
 * Fetch the challenge for a harmless path, compute `__test`, keep it.
 *
 * The `?i=1` the challenge itself appends is left out: the value is what the
 * server checks, not the query string.
 */
async function solve() {
  const res = await fetch(ORIGIN + '/watch/api/health', {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  const text = await res.text();
  const m = AES_RE.exec(text);
  if (!m) return ''; // no challenge at all: nothing to keep
  const plain = slowAesDecrypt(m[1], m[2], m[3]);
  return bytesToHex(plain);
}

async function cookie() {
  const now = Date.now();
  if (solved.value && now < solved.until) return solved.value;
  const value = await solve();
  /* The platform rotates its keys, and a dead cookie is indistinguishable from
   * a fresh one until a request comes back as a challenge page. Ten minutes is
   * short enough that a rotation is caught by the retry in `forward()`. */
  solved = { value, until: value ? now + 10 * 60 * 1000 : 0 };
  return value;
}

/* ============================ forwarding ============================ */

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Ksu-Relay',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Copy what the host must see; drop what describes the browser instead. */
function forwardHeaders(request, length) {
  const out = new Headers();
  out.set('User-Agent', UA);
  const ct = request.headers.get('Content-Type');
  if (ct) out.set('Content-Type', ct);
  const accept = request.headers.get('Accept');
  out.set('Accept', accept || '*/*');
  if (length !== null) out.set('Content-Length', String(length));
  /* No Connection header: forcing `close` costs a fresh TLS handshake to the
   * origin on every press, and the runtime pools connections for us. */
  return out;
}

async function forward(request, body, length, retried) {
  const url = new URL(request.url);
  const target = ORIGIN + url.pathname + url.search;
  const headers = forwardHeaders(request, length);
  const value = await cookie();
  if (value) headers.set('Cookie', '__test=' + value);

  const method = request.method.toUpperCase();
  const res = await fetch(target, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
    redirect: 'manual',
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  /* A rotated key answers with the challenge page wherever we expected JSON.
   * Solve again, once. A second failure is reported rather than looped. */
  if (!retried && (res.headers.get('Content-Type') || '').indexOf('text/html') === 0) {
    const peek = await res.clone().text();
    if (isChallenge(peek)) {
      solved = { value: '', until: 0 };
      return forward(request, body, length, true);
    }
  }

  const headersOut = new Headers(res.headers);
  headersOut.delete('Content-Encoding'); // the runtime already decoded it
  headersOut.delete('Transfer-Encoding');
  headersOut.delete('Connection');
  for (const [k, v] of Object.entries(corsHeaders(request))) headersOut.set(k, v);
  if (!headersOut.has('Cache-Control')) headersOut.set('Cache-Control', 'no-store');

  return new Response(res.body, { status: res.status, headers: headersOut });
}

export default {
  async fetch(request) {
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    try {
      if (method === 'GET' || method === 'HEAD') {
        return await forward(request, undefined, null, false);
      }

      /* Bodies are held in memory on purpose: the PHP side validates
       * CONTENT_LENGTH against what it wrote, and a retry after a rotated
       * cookie has to send the very same bytes again. */
      const bytes = await request.arrayBuffer();
      return await forward(request, bytes, bytes.byteLength, false);
    } catch (err) {
      return new Response(
        JSON.stringify({ ok: false, relay: true, error: String((err && err.message) || err) }),
        {
          status: 502,
          headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders(request)),
        }
      );
    }
  },
};
