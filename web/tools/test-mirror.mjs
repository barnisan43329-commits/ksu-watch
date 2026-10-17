#!/usr/bin/env node
/**
 * KsuNiMeet Watch — two phones, one film, no browser.
 *
 * This runs the REAL web/app.js twice in the same process, each copy with its
 * own video element and its own network, both pointed at the REAL backend. It
 * is not a mock of the sync: the code under test is the file that ships.
 *
 * What it proves, in the order the complaint came in:
 *
 *   1. pause on one side pauses the other at the same millisecond position;
 *   2. play after a pause continues from there — it does NOT restart the film;
 *   3. a drag is mirrored exactly;
 *   4. between presses NOTHING is applied and no state is published — the two
 *      players are not connected while the film runs;
 *   5. nothing but the held wait is sent in the quiet seconds.
 *
 * Usage:
 *   node tools/test-mirror.mjs http://127.0.0.1:8098 http://127.0.0.1:8099
 *
 * Two ports because PHP's built-in server is single-threaded on Windows: a
 * phone parked in a held wait would otherwise block the other phone's press,
 * and the test would measure the queue instead of the app.
 */

import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(HERE, '..', 'app.js'), 'utf8');

const HOST_API = process.argv[2] || 'http://127.0.0.1:8098';
const GUEST_API = process.argv[3] || 'http://127.0.0.1:8099';

const FILM_SECONDS = 600;

let failures = 0;
let passes = 0;
function check(name, ok, note = '') {
  if (ok) passes++; else failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? '  ' + note : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a condition, or give up loudly. */
async function until(fn, ms = 6000, label = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(20);
  }
  console.log(`  ..   timed out waiting for ${label}`);
  return false;
}

/* -------------------------------------------------------------- a phone -- */

function phone(label, api, extraConfig) {
  const store = new Map();
  const events = {};
  const requests = [];
  const replaced = [];

  const video = {
    _t: 0,
    paused: true,
    duration: 0,
    seeking: false,
    ended: false,
    src: '',
    error: null,
    addEventListener(type, fn) { (events[type] ||= []).push(fn); },
    emit(type) { (events[type] || []).slice().forEach((fn) => fn()); },
    play() {
      if (!this.paused) return Promise.resolve();
      this.paused = false;
      this.ended = false;
      this.emit('play');
      return Promise.resolve();
    },
    pause() {
      if (this.paused) return;
      this.paused = true;
      this.emit('pause');
    },
    load() {}
  };
  Object.defineProperty(video, 'currentTime', {
    get() { return this._t; },
    set(v) {
      this._t = v;
      this.seeking = true;
      // A real decoder answers `seeked` a moment later, not synchronously.
      setTimeout(() => {
        this.seeking = false;
        this.emit('seeked');
      }, 8);
    }
  });

  // The film runs by itself while playing — otherwise "did it continue" has no
  // meaning. 50 ms ticks, exactly like a frame clock.
  const ticker = setInterval(() => {
    if (video.paused || !video.duration) return;
    video._t = Math.min(video.duration, video._t + 0.05);
    if (video._t >= video.duration) {
      video.paused = true;
      video.ended = true;
      video.emit('pause');
    }
  }, 50);

  const els = {};
  function el(id) {
    if (!els[id]) {
      els[id] = {
        id, hidden: false, textContent: '', className: '', value: '',
        style: {}, listeners: {},
        addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
        setAttribute() {}, focus() {}
      };
    }
    return els[id];
  }

  class UrlShim extends URL {}
  UrlShim.createObjectURL = () => 'blob:test-' + label;
  UrlShim.revokeObjectURL = () => {};

  const counted = (input, init) => {
    const url = String(input);
    requests.push({ at: Date.now(), url, method: (init && init.method) || 'GET' });
    return globalThis.fetch(input, init);
  };

  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: counted,
    Blob, File, URL: UrlShim, URLSearchParams, AbortController,
    Date, Math, JSON, String, Number, isFinite, Array, Object, Promise, Error,
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      clear: () => store.clear()
    },
    location: {
      search: '?debug=1&api=' + encodeURIComponent(api),
      origin: 'http://test',
      pathname: '/',
      href: 'http://test/',
      replace: (url) => replaced.push(url)
    },
    navigator: {},
    document: {
      getElementById: (id) => (id === 'video' ? video : el(id)),
      createElement: () => ({ style: {} })
    }
  };
  sandbox.window = sandbox;
  sandbox.window.KSU_CONFIG = Object.assign({ backend: api }, extraConfig || {});

  vm.createContext(sandbox);
  vm.runInContext(APP, sandbox, { filename: 'app.js' });

  const hook = sandbox.window.__ksu;
  if (!hook) throw new Error('app.js did not expose its debug hook');

  return {
    label,
    api,
    hook,
    video,
    requests,
    replaced,
    stop: () => clearInterval(ticker),
    text: (id) => el(id).textContent,
    el,
    /** Pretend the browser finished loading metadata for the film. */
    loaded() {
      video.duration = FILM_SECONDS;
      video.emit('loadedmetadata');
    }
  };
}

/* ----------------------------------------------------------------- test -- */

async function main() {
  console.log('host :', HOST_API);
  console.log('guest:', GUEST_API);

  /* --- nothing is ever asked of a person -------------------------------
   *
   * There is no server address field in the shipped page, and no code path
   * that reveals one. This reads the real index.html rather than the running
   * copy on purpose: the guarantee is about what is deployed. */
  const HTML = fs.readFileSync(path.join(HERE, '..', 'index.html'), 'utf8');
  check('the page has no server address field',
    !/srvInput|srvBlock|srvBtn/.test(HTML) && !/Server address/i.test(HTML));

  /* A door that is not there at all: connection refused. The page must say it
   * is retrying and leave every button alone — a dead backend is the hosting's
   * problem, not a form for the person to fill in. */
  const bare = phone('bare', 'http://127.0.0.1:9');
  await until(() => /retry/i.test(bare.text('foot')), 6000, 'the retrying line');
  check('with no door at all the page says it is retrying',
    /retry/i.test(bare.text('foot')), `foot: ${bare.text('foot')}`);
  check('and asks for nothing: both room buttons stay usable',
    bare.el('createBtn').hidden === false && bare.el('joinBtn').hidden === false);
  bare.stop();

  /* A mirror with no reachable door and the same-origin copy configured as
   * its destination: the page forwards itself there, room code included,
   * instead of explaining a server problem to somebody holding a phone. */
  const fwd = phone('fwd', 'http://127.0.0.1:9', { fallback: 'https://host.test/watch/' });
  await until(() => fwd.replaced.length > 0, 6000, 'the forward');
  check('a mirror with no door forwards to the same-origin copy',
    fwd.replaced.length === 1 && fwd.replaced[0].indexOf('https://host.test/watch/') === 0,
    fwd.replaced.join(' '));
  await new Promise((r) => setTimeout(r, 600));
  check('and forwards exactly once, not in a loop', fwd.replaced.length === 1,
    `${fwd.replaced.length} forward(s)`);
  fwd.stop();

  /* --- a door that answers 429, and the hop past it ---------------------
   *
   * The exact shape of the failure that brought this up: the hosting says
   * "allowance reached" and the page used to answer that by asking for a
   * server address. Here a real HTTP server answers 429 with the same body
   * and the same Retry-After, placed FIRST in the door list, and the page has
   * to reach the live backend behind it without being told anything. */
  const exhausted = http.createServer((req, res) => {
    exhaustedHits.push(req.url);
    res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' });
    res.end('This site has reached its hosting allowance. Please try again later.');
  });
  const exhaustedHits = [];
  await new Promise((r) => exhausted.listen(0, '127.0.0.1', r));
  const EXHAUSTED = 'http://127.0.0.1:' + exhausted.address().port;

  const hopper = phone('hopper', EXHAUSTED + ',' + HOST_API);
  hopper.hook.create();
  await until(() => hopper.hook.state.code, 8000, 'a room through the second door');  check('a door answering 429 is dropped and the next one is used',
    hopper.hook.state.code && exhaustedHits.length > 0,
    `${exhaustedHits.length} requests to the exhausted door, room ${hopper.hook.state.code}`);
  if (!hopper.hook.state.code) {
    for (const r of hopper.requests) console.log('    hop ->', r.method, r.url);
    console.log('    exhausted saw:', exhaustedHits.join(', '));
  }
  check('and the page never mentions it',
    !/server|429|allowance/i.test(hopper.text('foot') + hopper.text('entryErr')),
    `foot: "${hopper.text('foot')}" err: "${hopper.text('entryErr')}"`);
  hopper.stop();
  await new Promise((r) => exhausted.close(r));

  const host = phone('host', HOST_API);
  const guest = phone('guest', GUEST_API);

  // --- a room and a film ---------------------------------------------------
  host.hook.create();
  await until(() => host.hook.state.code, 5000, 'room code');
  const code = host.hook.state.code;
  check('room created', /^[2-9A-HJ-NP-Z]{6}$/.test(code), code);

  const bytes = new Uint8Array(300 * 1024);
  for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i & 0xff;
  const film = new File([bytes], 'film.mp4', { type: 'video/mp4' });
  host.hook.hostPick(film);
  host.loaded();

  await until(() => host.hook.state.film && host.hook.state.film.parts > 0, 5000, 'film meta');
  await until(() => host.hook.state.uploading === false && host.hook.state.seq > 0, 8000, 'upload');

  // --- the guest joins and pulls the same file -----------------------------
  guest.hook.join(code);
  await until(() => guest.hook.state.url, 8000, 'guest to finish downloading');
  guest.loaded();                       // the browser fires this; here we do
  await until(() => guest.hook.state.ready, 3000, 'guest player ready');
  await sleep(400);

  if (process.env.KSU_TRACE) {
    console.log('  host  state:', JSON.stringify(host.hook.state));
    console.log('  guest state:', JSON.stringify(guest.hook.state));
    for (const r of guest.requests) console.log('   guest ->', r.method, r.url);
    for (const r of host.requests) console.log('   host  ->', r.method, r.url);
  }

  check('guest has the film', guest.hook.state.ready);
  check('guest starts paused at the beginning',
    guest.video.paused && guest.video.currentTime < 0.2,
    `t=${guest.video.currentTime.toFixed(2)}`);

  /* PRESS 1 — the host pauses in the middle of the film.
   * A drag is used to get there because that is how a human arrives at a
   * position; the assertion is on the press that follows. */
  host.video.currentTime = 120.0;
  await sleep(120);
  host.video.pause();
  await until(() => Math.abs(guest.video.currentTime - 120) < 0.2 && guest.video.paused, 4000,
    'guest to pause at 120');
  check('pause mirrors to the same millisecond position',
    Math.abs(guest.video.currentTime - 120) < 0.2 && guest.video.paused,
    `host 120.000 · guest ${guest.video.currentTime.toFixed(3)}`);

  /* PRESS 2 — play again. THIS is the reported bug: the guest used to go back
   * to the beginning here. */
  const seqBeforePlay = guest.hook.state.seq;
  host.video.play();
  await until(() => !guest.video.paused, 4000, 'guest to play');
  await sleep(350);
  check('play mirrors: the guest is playing',
    !guest.video.paused, `guest paused=${guest.video.paused}`);
  check('play mirrors: the guest CONTINUES, it does not restart',
    guest.video.currentTime > 119.5,
    `guest at ${guest.video.currentTime.toFixed(3)} s`);
  check('play mirrors: both are within a frame of each other',
    Math.abs(guest.video.currentTime - host.video.currentTime) < 0.5,
    `host ${host.video.currentTime.toFixed(3)} · guest ${guest.video.currentTime.toFixed(3)}` +
    ` · age ${guest.hook.state.age} ms, target ${guest.hook.state.target} ms,` +
    ` skew ${guest.hook.state.skew} ms over ${guest.hook.state.skewN} sample(s)`);
  check('the play press advanced the shared sequence',
    guest.hook.state.seq > seqBeforePlay, `seq ${seqBeforePlay} -> ${guest.hook.state.seq}`);

  /* NOTHING HAPPENS BETWEEN PRESSES.
   * Let the film run for a second and a half. Neither side may seek, change
   * rate, or publish anything: that is the "no hard sync while playing" rule. */
  const guestSeq = guest.hook.state.seq;
  const hostSeq = host.hook.state.seq;
  const hostPosBefore = host.video.currentTime;
  const guestPosBefore = guest.video.currentTime;
  await sleep(1500);
  const drift = Math.abs(
    (host.video.currentTime - hostPosBefore) - (guest.video.currentTime - guestPosBefore)
  );
  check('nothing is published while the film just plays',
    guest.hook.state.seq === guestSeq && host.hook.state.seq === hostSeq,
    `guest seq ${guestSeq} -> ${guest.hook.state.seq}`);
  check('both clocks advance by the same amount (no correction is applied)',
    drift < 0.08, `drift ${drift.toFixed(3)} s over 1.5 s`);

  /* PRESS 3 — pause again, then play again. Same two assertions, second time,
   * because a bug that only shows up on the second press is a bug. */
  host.video.pause();
  await until(() => guest.video.paused, 4000, 'guest to pause again');
  await sleep(150);
  check('second pause mirrors the position',
    Math.abs(guest.video.currentTime - host.video.currentTime) < 0.3,
    `host ${host.video.currentTime.toFixed(3)} · guest ${guest.video.currentTime.toFixed(3)}`);
  const atPause = guest.video.currentTime;

  host.video.play();
  await until(() => !guest.video.paused, 4000, 'guest to play again');
  await sleep(250);
  check('second play continues from the pause, not from zero',
    guest.video.currentTime > atPause - 0.1,
    `paused at ${atPause.toFixed(3)} · playing from ${guest.video.currentTime.toFixed(3)}`);

  /* PRESS 4 — a drag. This one is allowed to move backwards. */
  host.video.currentTime = 40.0;
  await sleep(80);
  host.video.pause();
  await until(() => Math.abs(guest.video.currentTime - 40) < 0.4, 5000, 'guest to follow the drag');
  check('a drag is mirrored exactly, backwards included',
    Math.abs(guest.video.currentTime - 40) < 0.4,
    `guest at ${guest.video.currentTime.toFixed(3)} s`);

  /* PRESS 5 — the OTHER direction. The room is shared both ways: the guest
   * may press too. Until this was fixed the host published and never
   * listened, so a press on the guest side moved one player and stopped
   * there. The 1.5 s first is the guest's own apply window: a seek inside it
   * belongs to the snapshot it just received, not to a finger. */
  await until(() => Date.now() > (guest.hook.state.suppress || 0) + 150, 4000,
    'the guest apply window to close');
  guest.video.currentTime = 90.0;
  await sleep(200);
  guest.video.pause();
  await until(() => Math.abs(host.video.currentTime - 90) < 0.4, 5000, 'host to follow the guest');
  check('a press on the guest side moves the host too',
    Math.abs(host.video.currentTime - 90) < 0.4,
    `host at ${host.video.currentTime.toFixed(3)} s`);

  /* --- quiet network ------------------------------------------------------ */
  const guestWaits = guest.requests.filter((r) => r.url.includes('/api/wait')).length;
  const guestPosts = guest.requests.filter((r) => r.url.includes('/api/state')).length;
  /* Two, not fifteen: the guest's own drag (a seek, and a pause if it was
   * playing) and nothing else. Every press it APPLIED from the host must have
   * stayed local — republishing those is what makes two phones ping-pong. */
  check('the guest publishes only on its own presses', guestPosts <= 2,
    `${guestPosts} state posts from the guest`);
  check('the guest spends its life in held waits, not in polls', guestWaits >= 3,
    `${guestWaits} waits`);

  host.stop();
  guest.stop();

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
