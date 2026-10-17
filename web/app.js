/* KsuNiMeet Watch — the whole frontend.
 *
 * ONE IDEA. The film never travels while it is being watched: each side has
 * the file on its own phone and plays it locally, so nothing buffers and
 * nothing stutters when the network does. The only thing that crosses the
 * network is the button: play, pause, seek.
 *
 * AND ONE RULE ABOUT THE BUTTON. Each press publishes a complete snapshot of
 * the film — position in milliseconds, playing or not, duration — and the
 * other side replaces its idea of the film with that snapshot, once. There is
 * no drift correction, no playback-rate nudge and no periodic "where are you"
 * while the film runs: between presses the two players are not connected at
 * all. That is exactly why the picture never stutters, and why a press lands
 * as one clean jump instead of a fight.
 *
 * The single hard part is that a jump BACKWARD may only happen for a command
 * that really means "be here" (a drag, or joining a room). If a play/pause
 * press could move the other side backwards, one bad position reading would
 * send the second phone to the beginning of the film — which is the classic
 * failure and the reason for BACK_MAX below.
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------- config -- */

  var CFG = window.KSU_CONFIG || {};

  /* ?api=http://host overrides config.js for one page load. It is how the test
   * harness drives the real page against a local backend, and how an operator
   * points a copy at a new host without editing and redeploying a file. */
  var PARAM = new URLSearchParams(location.search);

  /* ================================================================ doors ==
   *
   * WHERE THE ROOM SERVICE IS, AND WHY NOTHING HERE IS EVER ASKED OF A PERSON.
   *
   * There is no server field on this page and there is not going to be one. A
   * person watching a film is not an administrator: "the address is not
   * answering" is not a sentence they can act on, and a text box in front of
   * Create a room is a bug wearing a settings screen.
   *
   * So the page carries an ordered list of DOORS to the same backend, probes
   * them itself, keeps the fastest that answers, and hops to another the
   * moment one stops answering. A door is a base URL. '' means "this very
   * origin" — the deployment where the page is served by the PHP host itself,
   * which needs no door at all because there is nothing in between.
   *
   * The order of authority:
   *
   *   1. ?api=…        — comma separated, one page load; tests and operators;
   *   2. KSU_CONFIG.doors — the deployed list, fastest one wins the probe;
   *   3. the last door that answered on this phone (remembered, not asked);
   *   4. ''            — same origin, always last, always the safest.
   */

  function makeDoors() {
    var out = [];

    function add(value) {
      String(value === undefined || value === null ? '' : value).split(',').forEach(function (one) {
        var v = String(one).trim().replace(/\/+$/, '');
        if (v === '.' || v === '/') v = '';
        // A bare word is a typo, not a door. Only a real base URL, or ''.
        if (v && !/^https?:\/\/[^\s]/i.test(v)) return;
        if (out.indexOf(v) === -1) out.push(v);
      });
    }

    String(PARAM.get('api') || '').split(',').forEach(add);
    (CFG.doors || []).forEach(add);
    add(CFG.backend);

    var last = '';
    try { last = localStorage.getItem('ksu.door') || ''; } catch (e) { /* private mode */ }
    last = String(last).replace(/\/+$/, '');
    if (last && out.indexOf(last) > 0) {
      out.splice(out.indexOf(last), 1);
      out.unshift(last);
    }

    if (out.indexOf('') === -1) out.push('');
    return out;
  }

  var DOORS = makeDoors();
  var API = DOORS[0];

  /* Door -> the instant it may be tried again. A door that answered 429 with
   * `Retry-After` is left alone for that long; a dead one for a minute. This
   * is not a punishment, it is the only thing that stops a busy host from
   * being hammered by a page that is already waiting. */
  var DOWN = {};
  var picking = null;

  function isDown(base) {
    return DOWN[base] > now();
  }

  function coolFor(err) {
    var secs = 60;
    if (err && err.retryAfter > 0) secs = err.retryAfter;
    if (err && err.status === 429) secs = Math.max(secs, 120);
    return Math.min(secs, 900) * 1000;
  }

  /**
   * The URL for a call through a door.
   *
   * A door may be a whole base URL, or `''` for "this very origin". The empty
   * one must resolve against the DIRECTORY THIS PAGE WAS SERVED FROM, not
   * against the domain root: the same files can live at /watch/ and the API
   * path is always /api/…, so a root-relative call would ask the domain for
   * something that is not there. `./api/…` follows the document, wherever it
   * is installed.
   */
  function urlFor(base, path) {
    return base ? base + path : '.' + path;
  }

  /** One question to one door: are you the room service, and how fast are you? */
  function probe(base) {
    var t0 = now();
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 8000);
    /* A probe always ends as a value, never as a throw. `base` may be '' — a
     * relative fetch — and a runtime that refuses to resolve it throws
     * SYNCHRONOUSLY, before any promise exists to catch it. One door doing
     * that used to blow up the whole probe round and make every other door
     * look dead. */
    return Promise.resolve().then(function () {
      return fetch(urlFor(base, '/api/health'), {
        cache: 'no-store',
        signal: ctl ? ctl.signal : undefined
      });
    }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) {
        var e = new Error('http ' + r.status);
        e.status = r.status;
        var ra = Number(r.headers && r.headers.get && r.headers.get('Retry-After'));
        if (ra > 0) e.retryAfter = ra;
        throw e;
      }
      return r.json();
    }).then(function (h) {
      if (!h || h.ok !== true || h.name !== 'ksu-watch') throw new Error('not a room service');
      return { base: base, rtt: now() - t0 };
    }).catch(function (e) {
      clearTimeout(timer);
      return { base: base, err: e };
    });
  }

  /**
   * Find a door. In parallel, fastest first, and never more than one round of
   * probing at a time however many presses are queued behind it.
   */
  function pickDoor(retry) {
    var t = now();
    var order = DOORS.filter(function (d) { return !isDown(d); });
    if (!order.length) {
      // Every door is cooling down. That is a reason to try them all once
      // more, not a reason to strand the page: the cooldown protects a busy
      // host from a page that is already waiting, it does not outrank it.
      if (retry) return Promise.reject(new Error('no door answered'));
      DOWN = {};
      order = DOORS.slice();
    }

    return Promise.all(order.map(probe)).then(function (results) {
      var good = results.filter(function (r) { return !r.err; })
        .sort(function (a, b) { return a.rtt - b.rtt; });

      results.forEach(function (r) {
        if (r.err) DOWN[r.base] = now() + coolFor(r.err);
        else delete DOWN[r.base];
      });

      if (!good.length) {
        if (retry) throw new Error('no door answered');
        return pickDoor(true);
      }

      API = good[0].base;
      try { localStorage.setItem('ksu.door', API); } catch (e) { /* private mode */ }
      $('foot').textContent = '';
      return API;
    });
  }

  /** The door to use right now, choosing one if the current one is out. */
  function ensureDoor() {
    if (!isDown(API)) return Promise.resolve(API);
    if (!picking) {
      picking = pickDoor(false).then(function (base) { picking = null; return base; },
        function (e) { picking = null; throw e; });
    }
    return picking;
  }

  /** A door dying is not the app dying: say so, quietly, and hop. */
  function doorDown(base, err) {
    DOWN[base] = now() + coolFor(err);
    if (base === API) $('foot').textContent = 'reconnecting…';
  }

  function isDoorError(e) {
    if (!e) return false;
    // No status at all means the fetch never completed: DNS, TLS, offline, or
    // a relay that answered with a body that was not an answer.
    if (e.status === undefined || e.status === 0) return true;
    return e.status === 429 || e.status >= 500;
  }

  /* How close the two players have to be before a command stops bothering to
   * seek. 20 ms is under one frame at 25 fps: seeking for less moves the
   * picture by nothing and costs a decoder restart, which IS visible. */
  var EXACT_S = 0.02;

  /* How far back a play/pause press may move the other side. A real pause is
   * milliseconds away from where the other one is; three seconds is not a
   * pause, it is a bad reading. Drags and joins are exempt. */
  var BACK_MAX_S = 3.0;

  /* A held request the server may keep open. Shorter than the backend's own
   * cap so a slow host answers "nothing new" before it kills the request. */
  var WAIT_MS = 7000;

  /* Fallback polling, only used if the host will not hold a request open. */
  var POLL_MS = 300;

  /* --------------------------------------------------------------- state -- */

  var S = {
    code: (sessionStorage.getItem('ksu.code') || ''),
    who: newWho(),
    host: sessionStorage.getItem('ksu.host') === '1',
    film: null,          // {name, size, parts, chunk}
    url: '',             // object URL of the local film
    ready: false,        // metadata arrived, seeking is meaningful
    appliedT: -1,        // position we just forced on this element ourselves
    seq: 0,
    pending: null,       // snapshot that arrived before the player was ready
    suppress: 0,         // ignore our own events until this timestamp
    pumping: false,
    canWait: true,
    fails: 0,
    doorFails: 0,
    skew: 0,             // server clock minus this phone's clock, in ms
    skewN: 0,            // how many clock samples have been taken
    skewRtt: 0,          // round trip of the best of them, in ms
    ptLast: 0,           // the last press timestamp this phone published
    lastPtBy: {},        // sender -> last press applied, so a duplicate never lands twice
    uploading: false,
    downloading: false
  };

  var $ = function (id) { return document.getElementById(id); };
  var video = $('video');

  function isBinary(v) {
    return (typeof Blob !== 'undefined' && v instanceof Blob) ||
      (typeof ArrayBuffer !== 'undefined' && (v instanceof ArrayBuffer || ArrayBuffer.isView(v)));
  }

  function newWho() {
    var alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var s = '';
    for (var i = 0; i < 10; i++) s += alphabet[Math.floor(Math.random() * 36)];
    return s;
  }

  function now() { return Date.now(); }

  /* ----------------------------------------------------------------- api -- */

  function rawApi(base, path, opt) {
    opt = opt || {};
    var url = urlFor(base, path);
    var init = { method: opt.method || 'GET', cache: 'no-store' };
    if (opt.body !== undefined) {
      // A Blob is bytes and goes up as bytes. Stringifying one sends the two
      // characters "{}" — a film piece that is not a film piece, which the
      // decoder then refuses to open with a message about the format.
      if (isBinary(opt.body)) {
        init.body = opt.body;
        init.headers = { 'Content-Type': 'application/octet-stream' };
      } else {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(opt.body);
      }
    }
    if (opt.timeout) {
      // A held wait has to be allowed to outlast its own server-side hold.
      var ctl = new AbortController();
      init.signal = ctl.signal;
      var timer = setTimeout(function () { ctl.abort(); }, opt.timeout);
      return fetch(url, init).then(function (r) {
        clearTimeout(timer);
        return r;
      }, function (e) {
        clearTimeout(timer);
        throw e;
      });
    }
    return fetch(url, init);
  }

  /**
   * Every call the app makes goes through here.
   *
   * The point of the wrapper is one line: if the door in front of the backend
   * stops answering — a quota, a redeploy, a host falling over — the call is
   * repeated once through the next door that answers. The caller never learns
   * that it happened, and neither does the person holding the phone.
   *
   * Only transport-level failures hop. A 404 means the room is gone and a 400
   * means the request was wrong: another door would say the same thing.
   */
  function isDoorStatus(status) {
    return status === 429 || status >= 500;
  }

  function api(path, opt) {
    /* ONE retry, through one other door. Two would be a loop in a storm, and
     * if two doors in a row cannot answer, the third will not either. */
    return attempt(0);

    function attempt(n) {
      return ensureDoor().then(function (base) {
        return rawApi(base, path, opt).then(function (r) {
          /* A 429 is a RESPONSE, not a rejection. It used to travel straight
           * back to the caller, which meant "allowance reached" reached the
           * person as an error while every other door sat unused. A dead
           * door is a dead door whether it hangs up or answers politely. */
          if (r.ok || !isDoorStatus(r.status) || n > 0) return r;
          var ra = Number(r.headers && r.headers.get && r.headers.get('Retry-After'));
          doorDown(base, { status: r.status, retryAfter: ra > 0 ? ra : 0 });
          return attempt(n + 1);
        }, function (e) {
          if (!isDoorError(e) || n > 0) throw e;
          doorDown(base, e);
          return attempt(n + 1);
        });
      });
    }
  }

  function apiJson(path, opt) {
    var sentAt = now();
    return api(path, opt).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          var err = new Error('http ' + r.status + ' ' + t.slice(0, 80));
          err.status = r.status;
          var ra = Number(r.headers && r.headers.get && r.headers.get('Retry-After'));
          if (ra > 0) err.retryAfter = ra;
          throw err;
        });
      }
      return r.json();
    }).then(function (res) {
      var gotAt = now();
      /* Only fast answers refine the clock. A held wait is answered when a
       * press arrives, which says nothing about how long the wire took. */
      if (gotAt - sentAt < 1500) takeSkew(res, sentAt, gotAt);
      return res;
    });
  }

  /* ================================================================ link ==
   *
   * THE BUTTON'S SHORTCUT, AND WHY IT EXISTS.
   *
   * Measured on the live host, same origin, in a real browser: a press costs
   * ~530 ms to reach the other phone, and a 4 KB stylesheet from the same
   * host costs ~490 ms. So the delay is the wire to the PHP, not this file —
   * no amount of tidying the request makes it faster, because the request is
   * not what is slow.
   *
   * A press is tiny. It does not need to go through a server on another
   * continent at all: the two phones can hold a data channel and drop the
   * press straight across it. On the same wi-fi that is about a millisecond;
   * across a country, tens. The server is then needed for exactly one thing —
   * telling the phones where each other are (a dozen SDP lines), which is what
   * /api/sig is for.
   *
   * IF IT DOES NOT CONNECT, NOTHING BREAKS. Some networks refuse peer-to-peer
   * (symmetric NAT, aggressive firewalls). The offer goes unanswered, the link
   * gives up quietly after a few tries, and every press travels the way it
   * always did — through /api/state and /api/wait. The person never sees a
   * difference except the number.
   */

  var LINK = {
    pc: null,
    ch: null,
    peer: '',
    tries: 0,
    looking: false,
    stop: true,
    pressed: 0           // presses seen arriving over the channel, for the console
  };

  /* The channel that carries presses. One per room, never two. */
  function linkOpen() {
    return !!(LINK.ch && LINK.ch.readyState === 'open');
  }

  /** Start trying to reach the other phone. Cheap to call; it self-guards. */
  function startLink() {
    if (!S.code || linkOpen() || LINK.pc) return;
    if (typeof RTCPeerConnection !== 'function') return;
    LINK.stop = false;
    LINK.tries = 0;
    findPeer();
  }

  /** Who else is in the room? Then: the lower id offers, the higher answers. */
  function findPeer() {
    if (LINK.stop || LINK.looking || linkOpen() || LINK.pc) return;
    LINK.looking = true;

    apiJson('/api/room?code=' + S.code + '&who=' + S.who).then(function (res) {
      LINK.looking = false;
      var ids = (res && res.ids) || [];
      var other = '';
      for (var i = 0; i < ids.length; i++) {
        if (ids[i] !== S.who) other = ids[i];
      }
      if (!other) {
        if (LINK.tries++ < 8) setTimeout(findPeer, 2000);
        return;
      }
      LINK.peer = other;
      if (S.who < other) makeOffer(); else awaitOffer();
    }).catch(function () {
      LINK.looking = false;
      if (LINK.tries++ < 8) setTimeout(findPeer, 3000);
    });
  }

  function newPeer() {
    var pc = new RTCPeerConnection({
      // STUN only: no account, no TURN, nothing to pay for. A network that
      // needs TURN is a network where this link does not come up, and the
      // HTTP path carries the press instead.
      iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
    });

    pc.onicecandidate = function (e) {
      if (e.candidate && LINK.peer) sig('ice', e.candidate.toJSON ? e.candidate.toJSON() : {
        candidate: e.candidate.candidate,
        sdpMid: e.candidate.sdpMid,
        sdpMLineIndex: e.candidate.sdpMLineIndex
      });
    };

    pc.onconnectionstatechange = function () {
      var st = pc.connectionState;
      if (st === 'failed' || st === 'closed' || st === 'disconnected') giveUpLink();
    };

    return pc;
  }

  function goneUp(ch) {
    LINK.ch = ch;
    LINK.tries = 0;
    ch.onmessage = function (e) {
      var snap;
      try { snap = JSON.parse(e.data); } catch (err) { return; }
      if (!snap) return;

      /* A ping is not a press: it measures the wire and proves the channel is
       * alive. Two uses in one — the number in the status line is what the
       * press will cost, and a channel that stops answering is dropped before
       * ICE would notice. */
      if (snap.a === 'ping') {
        try { ch.send(JSON.stringify({ a: 'pong', at: snap.at })); } catch (err) { /* closed */ }
        return;
      }
      if (snap.a === 'pong') {
        if (snap.at) S.linkMs = Math.round(now() - snap.at);
        return;
      }

      if (snap.by === S.who) return;
      LINK.pressed++;
      apply(snap);
    };
    /* Only when it is ACTUALLY open: goneUp attaches to a channel that may
     * still be connecting, and a ping fired then would go nowhere and take
     * the timer with it. */
    ch.onopen = function () {
      status('linked · presses are direct', 'live');
      ping();
    };
    ch.onclose = function () {
      LINK.ch = null;
      stopPing();
      status('link lost — back on the room service', 'wait');
      pump();                       // presses travel through the server again
      setTimeout(startLink, 3000);  // and try to get the shortcut back
    };
    if (ch.readyState === 'open') {
      status('linked · presses are direct', 'live');
      ping();
    }
  }

  var pingTimer = 0;

  function ping() {
    if (!linkOpen()) { stopPing(); return; }
    try { LINK.ch.send(JSON.stringify({ a: 'ping', at: now() })); } catch (e) { /* closed */ }
    stopPing();
    pingTimer = setTimeout(ping, 20000);
  }

  function stopPing() {
    if (pingTimer) clearTimeout(pingTimer);
    pingTimer = 0;
  }

  function makeOffer() {
    var pc = newPeer();
    LINK.pc = pc;
    var ch = pc.createDataChannel('press', { ordered: true });
    goneUp(ch);

    pc.createOffer().then(function (o) { return pc.setLocalDescription(o); })
      .then(function () { sig('offer', { type: pc.localDescription.type, sdp: pc.localDescription.sdp }); })
      .catch(function () { giveUpLink(); });

    pollSig();
  }

  function awaitOffer() {
    var pc = newPeer();
    LINK.pc = pc;
    pc.ondatachannel = function (e) { goneUp(e.channel); };
    pollSig();
  }

  /** Send one handshake message to the other phone. */
  function sig(kind, data) {
    if (!LINK.peer) return;
    apiJson('/api/sig?code=' + S.code + '&who=' + S.who + '&to=' + LINK.peer, {
      method: 'POST',
      body: { kind: kind, data: data }
    }).catch(function () { /* the handshake is allowed to fail */ });
  }

  /**
   * Collect what the other phone left for me.
   *
   * Runs only while the link is being built: a second per poll, a few dozen
   * requests for a handshake that lasts about a second, and then not one more
   * request for as long as the channel is open.
   */
  function pollSig() {
    if (LINK.stop || linkOpen()) return;
    apiJson('/api/sig?code=' + S.code + '&who=' + S.who).then(function (res) {
      var msgs = (res && res.msgs) || [];
      for (var i = 0; i < msgs.length; i++) takeSig(msgs[i]);
      if (linkOpen()) return;
      if (++LINK.tries > 40) { giveUpLink(); return; }
      setTimeout(pollSig, 900);
    }).catch(function () {
      if (++LINK.tries > 40) giveUpLink();
      else setTimeout(pollSig, 1500);
    });
  }

  function takeSig(msg) {
    var pc = LINK.pc;
    if (!pc || !msg || !msg.data) return;
    var d = msg.data;

    if (msg.kind === 'offer') {
      // An offer arriving twice (a retry) must not restart the handshake.
      if (pc.signalingState !== 'stable') return;
      pc.setRemoteDescription(new RTCSessionDescription(d)).then(function () {
        return pc.createAnswer();
      }).then(function (a) {
        return pc.setLocalDescription(a);
      }).then(function () {
        sig('answer', { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
      }).catch(function () { giveUpLink(); });
      return;
    }

    if (msg.kind === 'answer') {
      if (pc.signalingState !== 'have-local-offer') return;
      pc.setRemoteDescription(new RTCSessionDescription(d)).catch(function () { giveUpLink(); });
      return;
    }

    if (msg.kind === 'ice' && d) {
      try { pc.addIceCandidate(new RTCIceCandidate(d)).catch(function () {}); } catch (e) { /* late */ }
    }
  }

  /** The link is not coming up. Say nothing, drop it, and keep working. */
  function giveUpLink() {
    LINK.stop = true;
    if (LINK.ch) { try { LINK.ch.close(); } catch (e) { /* already gone */ } }
    LINK.ch = null;
    if (LINK.pc) { try { LINK.pc.close(); } catch (e) { /* already gone */ } }
    LINK.pc = null;
    LINK.peer = '';
    pump();
  }

  /* -------------------------------------------------------------- screen -- */

  function show(which) {
    ['entry', 'pick', 'wait', 'stage'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.hidden = (id !== which);
    });
    $('roomBar').hidden = !S.code;
    if (S.code) $('codeText').textContent = S.code;
  }

  function status(text, kind) {
    $('statusText').textContent = text;
    var dot = $('dot');
    dot.className = 'dot' + (kind ? ' ' + kind : '');
  }

  function fail(where, err) {
    var el = $(where);
    if (!el) { console.log(err); return; }
    el.hidden = false;
    el.textContent = String(err && err.message ? err.message : err);
  }

  /* ---------------------------------------------------------- film local -- */

  /** Host: the chosen file becomes the player's source immediately. */
  function useLocalFile(file) {
    if (S.url) URL.revokeObjectURL(S.url);
    S.url = URL.createObjectURL(file);
    S.film = { name: file.name, size: file.size, parts: 0, chunk: 0 };
    video.src = S.url;
    video.load();
    show('stage');
    status('your film · setting up…', 'wait');
  }

  /** Guest: the pieces become one blob, and the blob becomes the source. */
  function useBlob(blob, type) {
    if (S.url) URL.revokeObjectURL(S.url);
    S.url = URL.createObjectURL(type ? blob.slice(0, blob.size, type) : blob);
    video.src = S.url;
    video.load();
    show('stage');
    status('film ready', 'wait');
  }

  /**
   * What kind of film this is.
   *
   * The pieces are bytes with no name, so the type has to come from the room —
   * or, if that room was made by an older build, from the file's extension. A
   * WebM typed as MP4 is not "slightly off": the decoder refuses to open it.
   */
  function filmType(film) {
    if (film && film.type) return film.type;
    var n = String((film && film.name) || '').toLowerCase();
    if (/\.webm$/.test(n)) return 'video/webm';
    if (/\.mkv$/.test(n)) return 'video/x-matroska';
    if (/\.mov$/.test(n)) return 'video/quicktime';
    if (/\.m4v$/.test(n)) return 'video/x-m4v';
    return 'video/mp4';
  }

  /* ------------------------------------------------------------ pressing -- */

  /**
   * Publish what the film is doing right now.
   *
   * This is the ONLY thing this app sends while a film is open, and it happens
   * ONLY when a human touched something. Nothing here is on a timer.
   */
  function push(action) {
    if (!S.ready || !S.code) return;
    // A seek that has not landed yet has no position to report: reporting the
    // old one would send the other side to where we WERE, and the next press
    // would look like a jump backwards.
    if (video.seeking) return;

    var d = isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
    var t = Math.round(video.currentTime * 1000);
    if (t < 0) t = 0;
    if (d > 0 && t > d) t = d;

    /* Monotonic, so two presses in the same millisecond are still two
     * different presses: the receiving side uses this number to recognise a
     * packet it has already applied — once down the data channel and once
     * through the server, since both are sent. */
    var pt = Math.round(now() + (S.skew || 0));
    if (pt <= (S.ptLast || 0)) pt = (S.ptLast || 0) + 1;
    S.ptLast = pt;

    /* THE SHORTCUT FIRST. A press down the open channel is there in the time
     * the packets take between two phones; the POST below is the durable copy
     * for a phone that joins later, and it is allowed to be slow. */
    if (linkOpen()) {
      try { LINK.ch.send(JSON.stringify({ t: t, p: video.paused ? 1 : 0, d: d, by: S.who, a: action, pt: pt })); }
      catch (e) { /* the socket died mid-send: the POST below still carries it */ }
    }

    apiJson('/api/state?code=' + S.code, {
      method: 'POST',
      body: {
        t: t,
        p: video.paused ? 1 : 0,
        d: d,
        by: S.who,
        a: action,
        /* the press moment in the SERVER's units (pt = pressed at). The
         * server stores it as a hint; the receiving side adds
         * (server now - pt) to the position, which is how a resumed film
         * starts where the sender actually is rather than one up-leg behind. */
        pt: pt
      }
    }).then(function (res) {
      // Our own snapshot comes back through the stream too. Moving the cursor
      // past it is what stops us from applying our own press to ourselves.
      if (res && res.snap) S.seq = Math.max(S.seq, res.snap.seq);
    }).catch(function () {
      status('not delivered — retrying on the next press', 'wait');
    });
  }

  /* ------------------------------------------------------------ applying -- */

  /**
   * Make this player do exactly what the snapshot says, once.
   *
   * @param {object} snap  {seq,t,p,d,at,by,a}
   */
  function apply(snap) {
    /* THE SAME PRESS ARRIVES TWICE, on purpose: down the data channel (fast)
     * and through the server (durable). Applying it twice would seek the film
     * to the same place twice — a visible hiccup, and for a frame or two the
     * picture would stutter. The press timestamp is unique and monotonic, so
     * it is the identity of the press. */
    if (snap.pt) {
      /* Per SENDER, not globally: two phones press independently and their
       * timestamps interleave. One shared high-water mark would throw away
       * whichever phone pressed "earlier" after the other one moved it on. */
      var who = snap.by || '';
      if (snap.pt <= (S.lastPtBy[who] || 0)) return;
      S.lastPtBy[who] = snap.pt;
    }

    if (!S.ready) { S.pending = snap; return; }

    var explicit = snap.a === 'seek' || snap.a === 'hello';
    /* HOW LONG AGO THE FINGER LANDED.
     *
     * Both timestamps in the snapshot are in the SERVER's units: `pt` (where
     * the finger was, stated by the phone that pressed) and `at` (where the
     * server wrote it down a leg later). Comparing either with this phone's
     * own clock would mix two clocks and produce a number with no meaning —
     * a server a second ahead made every packet look "not yet sent", the
     * travel time collapsed to zero, and a resumed film started a leg behind.
     *
     * S.skew is this phone's offset from the server, measured on the fastest
     * exchange it has had. Adding it turns the local clock into server units,
     * so the subtraction means what it says. */
    /* The press moment, not the store moment: `pt` is where the finger was in
     * server time, `at` the fallback for a phone that could not say (or an
     * older backend that does not store it). */
    var pressedAt = (snap.pt && snap.pt > 0) ? snap.pt : snap.at;
    var age = Math.max(0, Math.min(5, (now() + (S.skew || 0) - pressedAt) / 1000));

    // While the film runs, the sender has moved on since the packet left:
    // add the time it spent travelling. While paused, time is not passing and
    // the position IS the truth.
    var target = (snap.t / 1000) + (snap.p ? 0 : age);
    var d = isFinite(video.duration) ? video.duration : 0;
    if (d > 0) target = Math.min(target, d);
    if (target < 0) target = 0;

    /* Kept for the console and for a test to read: the two numbers that
     * decide whether a resumed film starts in the right place. */
    S.age = Math.round(age * 1000);
    S.target = Math.round(target * 1000);

    var delta = target - video.currentTime;
    var maySeek = Math.abs(delta) > EXACT_S && (explicit || delta > -BACK_MAX_S);

    /* TELL OUR OWN EVENTS APART FROM A HUMAN'S.
     *
     * Seeking a blob can take a moment and `seeked` may land well after the
     * press, so the window is generous. Without it the applied snapshot fires
     * play/pause/seeked, we publish that as if a finger did it, the other side
     * mirrors us, and the two phones spend the next seconds passing the same
     * press back and forth — visible as the picture jumping on its own. */
    S.suppress = now() + 1200;
    S.appliedT = target;

    if (maySeek) {
      try { video.currentTime = target; } catch (e) { /* not seekable yet */ }
    }
    if (snap.p) {
      video.pause();
    } else {
      var p = video.play();
      if (p && p.catch) {
        p.catch(function () {
          // Autoplay refused: the page has not been touched yet. Ask for one
          // tap instead of silently staying paused while the other side runs.
          $('tapStart').hidden = false;
        });
      }
    }

    status(snap.p ? 'paused together' : 'playing together', 'live');
    S.pending = null;
  }

  /* -------------------------------------------------------------- pump -- */

  /**
   * Sit in a held request. The server answers the instant a button is pressed,
   * so this loop is quiet: one request per press plus one per timeout.
   */
  function pump() {
    if (S.pumping || !S.code) return;
    /* The channel is up: presses come down it in milliseconds and nothing
     * needs to ask this host anything. One held request per phone per eight
     * seconds, forever, is exactly the cost this removes. */
    if (linkOpen()) return;
    S.pumping = true;

    var after = S.seq;
    var ms = S.canWait ? WAIT_MS : 0;
    var path = '/api/wait?code=' + S.code + '&after=' + after + '&ms=' + ms;

    apiJson(path, { timeout: ms + 6000 }).then(function (res) {
      S.pumping = false;
      S.fails = 0;
      S.doorFails = 0;
      if (res && res.snap && res.snap.seq > after) {
        S.seq = res.snap.seq;
        if (res.snap.by !== S.who) apply(res.snap);
      }
      pump();
    }).catch(function (err) {
      S.pumping = false;
      /* A door that died is not a host that cannot hold. Counting it as one
       * would drop the app into 300 ms polling right when the network is at
       * its worst, and it would stay there. The door is swapped instead, and
       * the hold is tried again through the next one. */
      if (isDoorError(err)) {
        doorDown(API, err);
        /* Back off, but not for long and never to a stop. A door that died is
         * usually a quota or a redeploy: it can come back on its own, and the
         * film must be sitting there waiting when it does. */
        S.doorFails = (S.doorFails || 0) + 1;
        setTimeout(pump, Math.min(15000, 600 * Math.pow(2, Math.min(5, S.doorFails))));
        return;
      }
      S.fails = (S.fails || 0) + 1;
      // A host that does not know the endpoint (an old or foreign backend)
      // falls back to plain polling at once. A host that KILLS held requests —
      // a free one has a process limit and does exactly that — is recognised by
      // failing three times in a row, and gives the same fallback. Without
      // that, a killed hold repeats every 400 ms and the app looks frozen.
      if (err && (err.status === 404 || err.status === 501)) S.canWait = false;
      if (S.fails >= 3) S.canWait = false;
      setTimeout(pump, S.canWait ? 400 : POLL_MS);
    });
  }

  /**
   * Learn the offset between the server's clock and this phone's.
   *
   * Transport delay is measured by comparing a packet's server timestamp with
   * the server's idea of now, so the two have to be reconciled once per answer.
   * Smoothed half-and-half: one slow answer should not jerk the players.
   */
  function takeSkew(res, sentAt, gotAt) {
    if (!res || typeof res.now !== 'number' || !res.now) return;
    /* The midpoint is what makes this an offset rather than a delay. The
     * server's `now` is stamped when the answer is built, so it lands about
     * half a round trip after we sent and half a round trip before we read:
     * comparing it with the midpoint of our own two timestamps cancels the
     * network out, and what is left is the difference between the clocks. */
    var sample = res.now - Math.round((sentAt + gotAt) / 2);
    var rtt = gotAt - sentAt;
    if (Math.abs(sample) > 300000) return;             // a stale or wrong answer
    /* KEEP THE BEST SAMPLE, NOT THE AVERAGE. The error in an offset measured
     * this way is half the round trip, so the answer from the FASTEST exchange
     * is the most accurate one — and a shared host answers in 300 ms one press
     * and 3 s the next. Averaging those together would import the 3 s one's
     * error into every position the other phone is given. */
    if (!S.skewN || rtt < S.skewRtt) {
      S.skew = sample;
      S.skewRtt = rtt;
    }
    S.skewN = (S.skewN || 0) + 1;
  }

  /** The one question this app asks: "where is the film right now?" */
  function askWhere() {
    if (!S.code) return;
    apiJson('/api/wait?code=' + S.code + '&after=-1&ms=0')
      .then(function (res) {
        if (!res || !res.snap || res.snap.seq <= 0) return;
        S.seq = Math.max(S.seq, res.snap.seq);
        if (res.snap.by === S.who) return;
        apply(res.snap);
      })
      .catch(function () { });
  }

  /* --------------------------------------------------------- host: film -- */

  function hostPick(file) {
    useLocalFile(file);
    $('pickHint').textContent = 'Playing from your phone. Copying to the room…';

    if (!file.size) {
      $('pickHint').textContent = 'That file is empty.';
      return;
    }

    apiJson('/api/health').then(function (h) {
      var chunk = (h && h.maxChunk) || (8 * 1024 * 1024);
      var parts = Math.ceil(file.size / chunk);
      S.film.chunk = chunk;
      S.film.parts = parts;

      return apiJson('/api/film?code=' + S.code, {
        method: 'POST',
        body: {
          name: file.name.slice(0, 120),
          size: file.size,
          parts: parts,
          chunk: chunk,
          type: file.type || ''
        }
      }).then(function () {
        S.uploading = true;
        return uploadParts(file, chunk, parts);
      });
    }).then(function () {
      S.uploading = false;
      $('pickHint').textContent = 'Copied. The other person can now pull it.';
      status('film copied · ' + S.film.parts + ' pieces', 'live');
      /* AND START LISTENING. The room is shared in both directions: the guest
       * may press play, pause or drag just as the host does, and until this
       * line existed the host published but never listened, so a press on the
       * guest side moved one player and nobody else. */
      askWhere();
      pump();
      startLink();
    }).catch(function (e) {
      S.uploading = false;
      $('pickHint').textContent = 'Copy stopped: ' + e.message;
    });
  }

  /** Pieces go up one at a time: a shared host has one small pipe and a limit. */
  function uploadParts(file, chunk, parts) {
    var i = 0;
    function once() {
      if (i >= parts) return Promise.resolve();
      var from = i * chunk;
      var slice = file.slice(from, Math.min(from + chunk, file.size));
      var idx = i;
      i++;
      return api('/api/part?code=' + S.code + '&idx=' + idx, {
        method: 'POST',
        body: slice
      }).then(function (r) {
        if (!r.ok) throw new Error('piece ' + idx + ' failed');
        $('pickHint').textContent = 'Copying to the room… ' + i + ' / ' + parts;
        // The other side can open the film once the first piece exists, so
        // publish where we are straight after it: a guest who joins now lands
        // in the right place even if nobody has pressed anything yet.
        if (i === 1) push('seek');
        return once();
      });
    }
    return once();
  }

  /* -------------------------------------------------------- guest: film -- */

  function guestWatch() {
    show('wait');
    $('waitText').textContent = 'Waiting for the film…';

    var tick = 0;
    function look() {
      if (S.url) return;                      // already have it
      apiJson('/api/room?code=' + S.code + '&who=' + S.who).then(function (res) {
        if (res.film && res.film.parts > 0) {
          S.film = res.film;
          return downloadAll(res.film);
        }
        tick++;
        $('waitText').textContent = res.people > 1
          ? 'Waiting for the film…'
          : 'Waiting for the other person…';
        setTimeout(look, 1500);
      }).catch(function (e) {
        $('waitText').textContent = 'Cannot reach the room: ' + e.message;
        setTimeout(look, 3000);
      });
    }
    look();
  }

  function downloadAll(film) {
    if (S.downloading) return Promise.resolve();
    S.downloading = true;
    show('wait');
    $('waitText').textContent = 'Getting the same film…';

    var blobs = [];
    var i = 0;
    function once() {
      if (i >= film.parts) return Promise.resolve();
      var idx = i;
      return api('/api/part?code=' + S.code + '&idx=' + idx)
        .then(function (r) {
          if (!r.ok) throw new Error('piece ' + idx + ' missing');
          return r.blob();
        })
        .then(function (b) {
          blobs.push(b);
          i++;
          $('dlBar').style.width = Math.round(100 * i / film.parts) + '%';
          $('dlHint').textContent = i + ' / ' + film.parts + ' pieces';
          return once();
        });
    }

    return once().then(function () {
      S.downloading = false;
      useBlob(new Blob(blobs), filmType(film));
      askWhere();                             // first and only "where are you"
      pump();
    }).catch(function (e) {
      S.downloading = false;
      $('dlHint').textContent = 'Download stopped: ' + e.message;
      setTimeout(function () { downloadAll(film); }, 3000);
    });
  }

  /* --------------------------------------------------------------- video -- */

  video.addEventListener('loadedmetadata', function () {
    S.ready = true;
    if (S.pending) {
      var p = S.pending;
      S.pending = null;
      apply(p);
    } else {
      status('ready · press play on either side', 'wait');
    }
  });

  // The three moments a human touched something. Nothing else publishes.
  video.addEventListener('play', function () {
    if (now() < S.suppress) return;
    push('play');
  });
  video.addEventListener('pause', function () {
    // Reaching the end also fires `pause`. That is the film finishing, not a
    // finger, and publishing it would tell the other side to stop at the end
    // when it is still in the middle.
    if (video.ended) return;
    if (now() < S.suppress) return;
    push('pause');
  });
  video.addEventListener('seeked', function () {
    // Some decoders deliver the seek we asked for after the window closed.
    // A landing within a frame of the position we forced is ours, not his —
    // and it is consumed once, so a real drag to that same spot still counts.
    if (S.appliedT >= 0 && Math.abs(video.currentTime - S.appliedT) < 0.25) {
      S.appliedT = -1;
      return;
    }
    if (now() < S.suppress) return;
    push('seek');
  });

  video.addEventListener('error', function () {
    status('this phone cannot play that file', 'wait');
  });

  $('tapStart').addEventListener('click', function () {
    $('tapStart').hidden = true;
    video.play().catch(function () { $('tapStart').hidden = false; });
    askWhere();
  });

  /* ---------------------------------------------------------------- flow -- */

  function saveSession() {
    sessionStorage.setItem('ksu.code', S.code);
    sessionStorage.setItem('ksu.host', S.host ? '1' : '0');
  }

  function createRoom() {
    apiJson('/api/room', { method: 'POST' }).then(function (res) {
      S.code = res.code;
      S.host = true;
      saveSession();
      show('pick');
      $('roomBar').hidden = false;
      $('codeText').textContent = S.code;
      $('pickHint').textContent = 'Room ' + S.code + ' is open.';
      startLink();                     // the guest may already be here
    }).catch(function (e) {
      fail('entryErr', 'The room service is not answering — it will retry on the next press.');
    });
  }

  function joinRoom(code) {
    code = String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (code.length !== 6) {
      fail('entryErr', 'A room code is six characters.');
      return;
    }
    S.code = code;
    S.host = false;
    saveSession();
    apiJson('/api/room?code=' + code + '&who=' + S.who).then(function (res) {
      startLink();                     // the shortcut, before any of the film
      if (res.film && res.film.parts > 0) {
        S.film = res.film;
        show('wait');
        downloadAll(res.film).then(pump);
      } else {
        guestWatch();
        pump();
      }
    }).catch(function (e) {
      if (e.status === 404) {
        S.code = '';
        fail('entryErr', 'No room with that code.');
      } else {
        fail('entryErr', 'The room service is not answering — it will retry on the next press.');
      }
    });
  }

  function copyLink() {
    var link = location.origin + location.pathname + '?r=' + S.code;
    var done = function () {
      $('copyBtn').textContent = 'Copied';
      setTimeout(function () { $('copyBtn').textContent = 'Copy link'; }, 1400);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(link).then(done, done);
    } else {
      done();
    }
  }

  /* ---------------------------------------------------------------- boot -- */

  function boot() {
    var q = PARAM;
    var fromLink = (q.get('r') || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

    /* ?debug=1 hands the page's own parts to the console. Two tabs of this app
     * are the only way to see a mirror before two phones are in the room, and
     * a test that drives the real page beats a mock of it. Installed first
     * because joining from a link returns before the rest of boot(). */
    if (q.get('debug') === '1') {
      window.__ksu = {
        state: S,
        apply: apply,
        push: push,
        hostPick: hostPick,
        create: createRoom,
        join: joinRoom,
        video: video,
        link: LINK,
        linked: linkOpen
      };
    }
    var saved = S.code;

    /* NOBODY IS ASKED WHERE THE BACKEND IS. The doors are probed here, once,
     * in parallel; the fastest that answers is the one this session uses and
     * the one remembered for next time. While that is happening the page says
     * so in the footer and the buttons still work — they wait for a door
     * rather than failing in front of somebody. */
    $('foot').textContent = 'connecting…';
    pickDoor(false).then(function () {
      $('foot').textContent = '';
      $('entryErr').hidden = true;
    }).catch(function () {
      /* Not one door answered. This is the hosting being down or a quota
       * being gone — neither of which a person can fix by typing an address,
       * and both of which clear up on their own. So the page says it is
       * trying, and keeps trying, and lights up by itself when a door is
       * back. Nothing is disabled: a press waits for a door. */
      offline();
    });

    $('createBtn').addEventListener('click', createRoom);
    $('joinBtn').addEventListener('click', function () {
      joinRoom($('codeInput').value);
    });
    $('codeInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') joinRoom($('codeInput').value);
    });
    $('copyBtn').addEventListener('click', copyLink);
    $('fileInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) hostPick(f);
    });

    if (fromLink && fromLink !== saved) {
      $('codeInput').value = fromLink;
      joinRoom(fromLink);
      return;
    }

    if (saved) {
      // A reload keeps the room. The host has to pick the file again (a browser
      // cannot reopen a file the person chose yesterday), the guest re-pulls it.
      apiJson('/api/room?code=' + saved + '&who=' + S.who).then(function (res) {
        if (S.host) {
          show('pick');
          $('pickHint').textContent = res.film
            ? 'Room ' + saved + ' still has the film. Pick your file again to keep watching.'
            : 'Room ' + saved + ' is open.';
        } else if (res.film && res.film.parts > 0) {
          S.film = res.film;
          startGuest();
        } else {
          guestWatch();
          pump();
        }
        startLink();                   // a reload keeps the room, and the link
      }).catch(function () {
        S.code = '';
        sessionStorage.clear();
        show('entry');
      });
      return;
    }

    show('entry');
  }

  /**
   * No door is answering. Say it once, keep retrying, recover on its own.
   *
   * A retry loop here is not a poll of the room — nothing about the film
   * depends on it — it is the page looking up every few seconds to see whether
   * the hosting is back. When it is, `API` is set and the footer clears
   * without a reload and without a word from the person. */
  function offline() {
    /* A LAST DOOR THAT IS NOT A DOOR.
     *
     * This page can be opened from two places: the host that runs the API
     * itself (where nothing can fail this way) and a mirror on another origin
     * that needs a door in between. When the mirror's doors are all out — a
     * quota, a bad night at the door — the mirror has no business showing an
     * error to somebody who just wants to watch a film. It forwards them, once,
     * to the copy that is the same site as the API, room code included.
     *
     * Guarded three ways so it can never loop: only when a destination is
     * configured, never when we are already there, and only once per tab. */
    var fb = String(CFG.fallback || '');
    if (fb && typeof location.replace === 'function' && location.href.indexOf(fb) !== 0) {
      var forwarded = '0';
      try { forwarded = sessionStorage.getItem('ksu.fwd') || '0'; } catch (e) { /* private mode */ }
      if (forwarded !== '1') {
        try { sessionStorage.setItem('ksu.fwd', '1'); } catch (e) { /* private mode */ }
        var r = PARAM.get('r') || '';
        location.replace(fb + (r ? '?r=' + encodeURIComponent(r) : ''));
        return;
      }
    }

    $('foot').textContent = 'not connected — retrying';
    if ($('entryErr').hidden) {
      $('entryErr').hidden = false;
      $('entryErr').textContent = 'The room service is not answering. This page keeps trying by itself — nothing to set up.';
    }
    setTimeout(function () {
      DOWN = {};
      ensureDoor().then(function () {
        $('foot').textContent = '';
        $('entryErr').hidden = true;
      }).catch(offline);
    }, 8000);
  }

  function startGuest() {
    show('wait');
    downloadAll(S.film).then(pump);
  }

  boot();
})();
