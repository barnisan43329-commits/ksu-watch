#!/usr/bin/env node
/**
 * KsuNiMeet Watch — how long does a press take to reach the other side?
 *
 * language: JavaScript, runtime: Node 18+, target: the real PHP backend
 *
 * The app's whole promise is "press, and both screens do it together". This
 * measures that promise in the only place it can be measured: a real room on
 * the real host, one client holding the wait and one client pressing.
 *
 * For every press it records four numbers, in milliseconds:
 *
 *   rtt     a plain GET /api/health first — the floor, nothing can beat it
 *   post    press -> the POST that stores it returns
 *   wake    press -> the held request on the other side is released
 *   age     what the receiving phone adds to the film position (server's own
 *           now minus the press timestamp) — the correction that keeps both
 *           players at the same millisecond despite the delay
 *
 *   node web/tools/bench-latency.mjs http://127.0.0.1:8096/watch [presses]
 *
 * Against a local door this still goes through the real Cloudflare Worker and
 * the real InfinityFree PHP, so the numbers are the numbers.
 */

const BASE = (process.argv[2] || 'http://127.0.0.1:8096/watch').replace(/\/+$/, '');
const N = Number(process.argv[3] || 12);

const pct = (arr, p) => {
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};
const show = (label, arr) =>
  console.log(
    `  ${label.padEnd(6)} p50 ${String(pct(arr, 50)).padStart(5)} ms` +
      `   p95 ${String(pct(arr, 95)).padStart(5)} ms` +
      `   max ${String(Math.max(...arr)).padStart(5)} ms`
  );

const json = async (url, init) => {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  return r.json();
};

const room = await json(BASE + '/api/room', { method: 'POST' });
const code = room.code;
console.log('room', code, 'at', BASE);

// The receiver's clock offset from the server, measured the way app.js does:
// the fastest round trip wins, and the offset is against its midpoint.
let skew = 0;
let bestRtt = Infinity;
const rtts = [];
for (let i = 0; i < 5; i++) {
  const t0 = Date.now();
  const h = await json(BASE + '/api/health');
  const t3 = Date.now();
  const rtt = t3 - t0;
  rtts.push(rtt);
  if (rtt < bestRtt) {
    bestRtt = rtt;
    skew = h.now - Math.round((t0 + t3) / 2);
  }
}

const posts = [];
const wakes = [];
const ages = [];
const writes = [];

for (let i = 0; i < N; i++) {
  const before = await json(BASE + '/api/wait?code=' + code + '&after=-1&ms=0');
  const after = before.snap.seq;

  // The other phone parks in the held request, exactly as the app does.
  const tOpen = Date.now();
  const held = json(BASE + '/api/wait?code=' + code + '&after=' + after + '&ms=8000');

  await new Promise((r) => setTimeout(r, 250));

  const pt = Date.now() + skew;              // press moment, in server units
  const tSend = Date.now();
  const stored = await json(BASE + '/api/state?code=' + code, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: 60000 + i * 100, p: i % 2, d: 600000, by: 'bench', a: 'play', pt }),
  });
  const tPost = Date.now();

  const released = await held;
  const tRecv = Date.now();

  posts.push(tPost - tSend);
  wakes.push(tRecv - tSend);
  writes.push(stored.snap.at - pt);
  ages.push(tRecv + skew - pt);

  if (process.env.KSU_TRACE) {
    console.log(`  #${i} open ${tOpen} post ${tPost - tSend} wake ${tRecv - tSend} seq ${released.snap.seq}`);
  }
}

console.log('\npress -> other side (ms)');
show('rtt', rtts);
show('post', posts);
show('wake', wakes);
show('age', ages);
console.log('\nserver wrote the press after the finger landed (ms)');
show('write', writes);
console.log(`\n${N} presses, ${BASE}`);
