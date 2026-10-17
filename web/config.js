/* KsuNiMeet Watch — where the backend lives.
 *
 * THIS IS THE ONLY FILE THAT CHANGES BETWEEN DEPLOYMENTS.
 *
 * Put the address of the PHP backend below, with no trailing path and no
 * /api — the frontend adds that itself.
 *
 * The address below is the live InfinityFree deployment: the backend is
 * uploaded to htdocs/watch/ on this account. If the site is moved, this line
 * is the only thing to edit and push.
 *
 * An empty string means "ask on the entry screen and remember it on the
 * phone", which is how the APK works if it is built without an address.
 */
window.KSU_CONFIG = {
  backend: "https://ksunimeet.great-site.net/watch"
};
