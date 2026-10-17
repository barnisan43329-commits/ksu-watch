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

  /* ?api=http://host overrides config.js for one page load. It is how you
   * point a phone at a different backend without editing and re-deploying a
   * file, and how the two-tab test drives the real page. */
  var PARAM = new URLSearchParams(location.search);

  /*
   * Where the backend is, in order of authority:
   *
   *   1. ?api=…          — one page load, used by tests and by a phone that is
   *                        being pointed at another server by hand;
   *   2. config.js       — the deployed answer, and the right one for the web;
   *   3. this phone      — asked once on the entry screen and remembered. This
   *                        is what makes the APK usable: a film app cannot
   *                        ship with somebody else's server address baked in,
   *                        and it cannot be rebuilt for every host either.
   */
  function resolveApi() {
    var fromStore = '';
    try { fromStore = localStorage.getItem('ksu.api') || ''; } catch (e) { /* private mode */ }
    return String(PARAM.get('api') || CFG.backend || fromStore || '').replace(/\/+$/, '');
  }

  var API = resolveApi();

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

  function api(path, opt) {
    opt = opt || {};
    var url = API + path;
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

  function apiJson(path, opt) {
    return api(path, opt).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          var err = new Error('http ' + r.status + ' ' + t.slice(0, 80));
          err.status = r.status;
          throw err;
        });
      }
      return r.json();
    });
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

    apiJson('/api/state?code=' + S.code, {
      method: 'POST',
      body: { t: t, p: video.paused ? 1 : 0, d: d, by: S.who, a: action }
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
    if (!S.ready) { S.pending = snap; return; }

    var explicit = snap.a === 'seek' || snap.a === 'hello';
    var age = Math.max(0, Math.min(5, (now() - snap.at) / 1000));

    // While the film runs, the sender has moved on since the packet left:
    // add the time it spent travelling. While paused, time is not passing and
    // the position IS the truth.
    var target = (snap.t / 1000) + (snap.p ? 0 : age);
    var d = isFinite(video.duration) ? video.duration : 0;
    if (d > 0) target = Math.min(target, d);
    if (target < 0) target = 0;

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
    S.pumping = true;

    var after = S.seq;
    var ms = S.canWait ? WAIT_MS : 0;
    var path = '/api/wait?code=' + S.code + '&after=' + after + '&ms=' + ms;

    apiJson(path, { timeout: ms + 6000 }).then(function (res) {
      S.pumping = false;
      S.fails = 0;
      if (res && res.snap && res.snap.seq > after) {
        S.seq = res.snap.seq;
        if (res.snap.by !== S.who) apply(res.snap);
      }
      pump();
    }).catch(function (err) {
      S.pumping = false;
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
    }).catch(function (e) {
      fail('entryErr', 'Cannot reach the server: ' + e.message);
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
        fail('entryErr', 'Cannot reach the server: ' + e.message);
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
        video: video
      };
    }
    var saved = S.code;

    $('foot').textContent = API ? ('server: ' + API.replace(/^https?:\/\//, '')) : 'server: not set';

    // No backend anywhere: ask for it here rather than letting every action
    // fail with a network error the person cannot act on.
    if (API) {
      // Say something useful when the server is configured but not answering.
      // "Cannot reach the server" with the address it tried is a sentence the
      // owner can act on; a dead Create button is not.
      apiJson('/api/health', { timeout: 9000 }).catch(function (e) {
        $('entryErr').hidden = false;
        $('entryErr').textContent = 'The server at ' + API + ' is not answering (' +
          (e && e.message ? e.message : e) + '). Correct the address below.';
        $('srvBlock').hidden = false;
        $('srvInput').value = API;
      });
    }

    if (!API) {
      $('srvBlock').hidden = false;
      $('createBtn').hidden = true;
      $('joinBtn').hidden = true;
      $('codeInput').hidden = true;
    }

    {
      var save = function () {
        var v = String($('srvInput').value || '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\/[^\s]+$/i.test(v)) {
          $('srvErr').hidden = false;
          $('srvErr').textContent = 'A full address, starting with http:// or https://';
          return;
        }
        try { localStorage.setItem('ksu.api', v); } catch (e) { /* private mode */ }
        location.reload();
      };

      $('srvBtn').addEventListener('click', function() { save(); });
    }

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
      }).catch(function () {
        S.code = '';
        sessionStorage.clear();
        show('entry');
      });
      return;
    }

    show('entry');
  }

  function startGuest() {
    show('wait');
    downloadAll(S.film).then(pump);
  }

  boot();
})();
