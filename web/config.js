/* KsuNiMeet Watch — the doors to the backend.
 *
 * READ THIS ONCE. There is nothing here to fill in, and there is no server
 * field on the page. The list below is a set of DOORS to the same PHP backend;
 * the page probes them in parallel at load, uses the fastest one that answers,
 * and hops to the next the moment one stops answering. A dead door costs the
 * person nothing — no message, no setting, no reload.
 *
 *     GitHub Pages  ──►  door  ──►  https://ksunimeet.gt.tc/watch  (PHP)
 *
 * WHY A DOOR AT ALL. InfinityFree wraps every response from a free-hosting
 * account in a JavaScript anti-bot challenge, and that challenge carries no
 * Access-Control-Allow-Origin. A page on another origin is refused before it
 * can read the answer, and InfinityFree documents cross-origin AJAX as
 * unsupported on free hosting with no switch to turn it off. A door solves the
 * challenge once, server-side, and answers the page with CORS. The PHP still
 * does every byte of the work.
 *
 * AND WHY THE PAGE IS ALSO DEPLOYED ON THE PHP HOST ITSELF. Same origin: no
 * door, no CORS, no third party, no request allowance but the host's own. That
 * deployment is `https://ksunimeet.gt.tc/watch/` and it uses `config.host.js`,
 * whose door list is empty — '' means "this very origin". When this page is
 * opened from there, not one line below is used.
 *
 * Both doors below are the same relay on two environments of the same
 * account, so they share one daily request allowance; that is why the list is
 * probed per load rather than trusted, and why a 429 puts a door to sleep for
 * two minutes instead of being retried on every press. Resets 00:00 UTC.
 *
 * No trailing slash, no /api — the page adds that itself.
 */
window.KSU_CONFIG = {
  doors: [
    "https://site-6d82979dc7d4471590b04884f411bb74.freebuff.page/watch",
    "https://site-b63c147a1f7f42eba6ca2091e31cdbc8.freebuff.page/watch"
  ],

  /* WHERE TO GO WHEN EVERY DOOR IS OUT.
   *
   * This page is a mirror on another origin, so it needs a door in between and
   * a door can run out of allowance. The copy below is served BY the PHP host,
   * which means the page and the API are the same site: no door, no CORS, no
   * third-party allowance at all. When no door answers, this page forwards the
   * person there — once, room code and all — instead of showing them an error
   * about a server they have never heard of. */
  fallback: "https://ksunimeet.gt.tc/watch/"
};
