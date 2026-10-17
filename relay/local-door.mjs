#!/usr/bin/env node
/**
 * KsuNiMeet Watch — a door on this machine.
 *
 * language: JavaScript, runtime: Node 18+, target: the real relay worker and the real PHP backend
 *
 * WHY THIS EXISTS. The tests have to run against the real PHP, and they must
 * not spend the deployed door's daily request allowance doing it — probing a
 * live door until it answers 429 is a test that breaks the thing it is testing.
 *
 * So this listens on localhost and hands every request to `worker.fetch`
 * directly, in this process. Same worker code, same solved challenge, same
 * bytes to and from InfinityFree — with no Cloudflare platform in the middle
 * and no allowance consumed.
 *
 * The path is passed through untouched, so it is called the same way as a
 * deployed door:
 *
 *     node relay/local-door.mjs 8098 8099
 *     node web/tools/test-mirror.mjs http://127.0.0.1:8098/watch http://127.0.0.1:8099/watch
 *
 * Two ports when a test needs two clients: one holds a long-poll open, and a
 * single listener would serialise them.
 */

import http from 'node:http';

const worker = (await import('./worker.js')).default;

const ports = process.argv.slice(2).map(Number).filter((n) => n > 0);
if (!ports.length) {
  console.error('usage: node local-door.mjs <port> [port…]');
  process.exit(2);
}

function serve(port) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === 'host' || k === 'connection' || k === 'content-length') continue;
        headers[k] = v;
      }
      // Content-Length is set by fetch from the body itself: passing the
      // received one through would mis-state a chunked upload.
      const init = { method: req.method, headers };
      if (req.method !== 'GET' && req.method !== 'HEAD') init.body = body;

      try {
        const answer = await worker.fetch(
          new Request('http://127.0.0.1:' + port + req.url, init)
        );
        const out = Buffer.from(await answer.arrayBuffer());
        const head = {};
        answer.headers.forEach((v, k) => {
          if (k === 'content-encoding' || k === 'transfer-encoding') return;
          head[k] = v;
        });
        head['content-length'] = String(out.length);
        res.writeHead(answer.status, head);
        res.end(out);
      } catch (err) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, localDoor: true, error: String(err && err.message) }));
      }
    });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log('door on http://127.0.0.1:' + port + '/watch');
  });
  return server;
}

ports.forEach(serve);
