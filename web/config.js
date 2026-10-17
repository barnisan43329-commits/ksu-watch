/* KsuNiMeet Watch — where the backend lives.
 *
 * THIS IS THE ONLY FILE THAT CHANGES BETWEEN DEPLOYMENTS.
 *
 * Put the address of the PHP backend below, with no trailing path and no
 * /api — the frontend adds that itself. Examples:
 *
 *   window.KSU_CONFIG = { backend: "https://ksu.infinityfreeapp.com" };
 *   window.KSU_CONFIG = { backend: "http://192.168.1.7:8090" };
 *
 * An empty string means "same origin as this page", which is what you want if
 * you ever copy web/ onto the PHP host itself instead of GitHub Pages.
 */
window.KSU_CONFIG = {
  backend: ""
};
