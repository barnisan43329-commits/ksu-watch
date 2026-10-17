/* KsuNiMeet Watch — where the backend lives.
 *
 * THIS IS THE ONLY FILE THAT CHANGES BETWEEN DEPLOYMENTS.
 *
 * The address below is the relay (CURRENT/relay), and the relay is a door in
 * front of the PHP on InfinityFree:
 *
 *     GitHub Pages  ──►  relay  ──►  https://ksunimeet.gt.tc/watch  (PHP)
 *
 * WHY THE DOOR. InfinityFree answers every request from a free-hosting
 * account with a JavaScript anti-bot challenge, and that challenge carries no
 * Access-Control-Allow-Origin. A browser on another origin never sees the
 * JSON: the fetch is refused before any of this code runs. InfinityFree
 * documents cross-origin AJAX as unsupported on free hosting and there is no
 * switch to turn it off. The relay solves the challenge once on the server
 * side and answers the page with CORS, so the PHP still does all of the work
 * and the page never notices the wall.
 *
 * No trailing slash, no /api — the page adds that itself.
 *
 * An empty string means "ask on the entry screen and remember it on the
 * phone", which is how the APK works if it is built without an address.
 */
window.KSU_CONFIG = {
  backend: "https://site-6d82979dc7d4471590b04884f411bb74.freebuff.page/watch"
};
