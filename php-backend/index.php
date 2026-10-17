<?php
/**
 * KsuNiMeet Watch — API.
 *
 * Six endpoints, no database, no login. A room code is the credential and a
 * film is a directory of 8 MB pieces.
 *
 *   GET  /api/health                 is this our backend, and how big may a piece be
 *   POST /api/room                   create a room                -> {code}
 *   GET  /api/room?code=             film, people, server time
 *   POST /api/film?code=             film name/size/pieces (JSON body)
 *   POST /api/part?code=&idx=        one piece of the film (raw body)
 *   GET  /api/part?code=&idx=        the same piece back, byte for byte
 *   POST /api/state?code=            a button was pressed          -> snapshot
 *   GET  /api/wait?code=&after=&ms=  HOLD until seq > after       -> snapshot
 *   POST /api/sig?code=&who=&to=     one WebRTC handshake message for the other phone
 *   GET  /api/sig?code=&who=         collect mine, once
 *
 * The last one is the reason the app feels instant: it does not ask "anything
 * new?" four times a second, it asks and waits, and the answer is written the
 * same millisecond a button is pressed.
 */

declare(strict_types=1);

require_once __DIR__ . '/lib.php';
require_once __DIR__ . '/api/room.php';
require_once __DIR__ . '/api/film.php';
require_once __DIR__ . '/api/sync.php';
require_once __DIR__ . '/api/sig.php';

if (!KSU_DEBUG) {
    ini_set('display_errors', '0');
}
// A held request must not be killed by the default 30 s limit while it waits.
set_time_limit(60);

ksu_cors();
ksu_sweep();

$path = (string) (parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/');
$path = '/' . trim($path, '/');
$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));

/* WHERE IS THE APP, WHEN IT IS NOT AT THE DOMAIN ROOT.
 *
 * A shared host usually gives you a subdirectory (/watch), and the same files
 * have to work at /watch/api/health and at /api/health. SCRIPT_NAME says
 * exactly where the router itself is, so the prefix can be taken off instead
 * of guessed. Everything below then sees a path as if the app were at the
 * root: '/' for the folder, '/api/health' for the probe. */
$script = str_replace('\\', '/', (string) ($_SERVER['SCRIPT_NAME'] ?? ''));
$base = rtrim(dirname($script), '/');
if ($base === '.' || $base === '\\') {
    $base = '';
}
if ($base !== '' && strpos($path, $base) === 0) {
    $path = substr($path, strlen($base));
    if ($path === '' || $path === false) {
        $path = '/';
    }
}

// Behind a proxy or a host that changes SCRIPT_NAME, match on the tail anyway.
if (($pos = strpos($path, '/api/')) !== false) {
    $path = substr($path, (int) $pos);
}
$path = '/' . trim($path, '/');

/* THE PAGE, FROM THE SAME FOLDER.
 *
 * When this folder also holds the frontend, the bare directory must open the
 * page and not the router. DirectoryIndex would do it, except a shared host's
 * account-wide .htaccess already lists index.php first and a per-directory
 * DirectoryIndex is not guaranteed to win. So the router answers for the
 * directory itself: same URL, same origin as the API, no redirect and nothing
 * for a person to type. */
if ($path === '/' && $method === 'GET' && is_file(__DIR__ . '/index.html')) {
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-cache');
    readfile(__DIR__ . '/index.html');
    exit;
}

switch ($path) {
    case '/api/health':
        ksu_health();
        break;

    case '/api/room':
        if ($method === 'POST') {
            ksu_room_create();
        }
        ksu_room_get();
        break;

    case '/api/film':
        if ($method !== 'POST') {
            ksu_err(405, 'POST only');
        }
        ksu_film_put();
        break;

    case '/api/part':
        if ($method === 'POST') {
            ksu_part_put();
        }
        ksu_part_get();
        break;

    case '/api/state':
        if ($method !== 'POST') {
            ksu_err(405, 'POST only');
        }
        ksu_state_put();
        break;

    case '/api/wait':
        ksu_wait();
        break;

    /* The two phones introducing themselves so the button can skip the
     * server afterwards. Once it works, no press comes back here. */
    case '/api/sig':
        if ($method === 'POST') {
            ksu_sig_put();
        }
        ksu_sig_get();
        break;

    default:
        ksu_err(404, 'no such endpoint');
}

/** What the frontend probes to know it found its own backend and not a parked page. */
function ksu_health(): void
{
    ksu_json([
        'ok' => true,
        'name' => 'ksu-watch',
        'now' => ksu_now_ms(),
        'maxChunk' => KSU_CHUNK,
        'waitMs' => KSU_WAIT_MS,
        'writable' => is_dir(KSU_DATA) && is_writable(KSU_DATA),
        'version' => 2,
    ]);
}
