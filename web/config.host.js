/* KsuNiMeet Watch — the copy that is served BY the PHP host.
 *
 * deploy-host.sh uploads this file as `config.js` next to index.html inside
 * htdocs/watch/, and it is the whole reason that deployment needs no relay:
 * the page and the API are the same site.
 *
 * An empty door list leaves exactly one entry, `''` — "this very origin" — so
 * every call is an ordinary relative request to /api/… on the same host. The
 * browser solves InfinityFree's challenge by itself because it IS the site, the
 * cookie is first-party, and there is no other origin anywhere in the path.
 *
 * Nothing to configure here either. If the page is moved to another host, this
 * file follows it: same origin, same empty list, still no address to type.
 */
window.KSU_CONFIG = { doors: [] };
