<?php
/**
 * KsuNiMeet Watch — storage helpers.
 *
 * No database on purpose. A room is a directory and a snapshot is one small
 * JSON file, so the same backend runs on any PHP host, including free ones
 * that give you 400 MB of disk and one MySQL database you would rather not
 * spend on a two-person film.
 *
 * ATOMICITY. Two phones write snapshots at the same time in the worst case,
 * and a half-written JSON would be read as "no snapshot". Every write goes to
 * a temporary file in the same directory and is then renamed over the target —
 * rename is atomic on every filesystem this will ever run on.
 */

require_once __DIR__ . '/config.php';

/* ---------------------------------------------------------------- output -- */

function ksu_cors(): void
{
    // The app is served from GitHub Pages (or from file:// inside the APK), so
    // the API is always cross-origin. There is no cookie and no session here:
    // a room code is the whole credential.
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 86400');
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
}

function ksu_json($data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function ksu_err(int $code, string $why): void
{
    ksu_json(['error' => $why], $code);
}

/** Now, in milliseconds, from the SERVER clock. Phone clocks are never trusted. */
function ksu_now_ms(): int
{
    return (int) round(microtime(true) * 1000);
}

/**
 * Cut a string to a length in CHARACTERS, not bytes.
 *
 * substr() on a UTF-8 name ends mid-character, and the other phone then shows
 * a replacement box instead of the film's name — with no clue why.
 */
function ksu_cut(string $s, int $max): string
{
    if (function_exists('mb_substr')) {
        return mb_substr($s, 0, $max, 'UTF-8');
    }
    if (strlen($s) <= $max) {
        return $s;
    }
    // No mbstring on this host: cut on a byte boundary and step back off any
    // continuation byte, so the result is still valid UTF-8.
    $cut = substr($s, 0, $max);
    while ($cut !== '' && (ord($cut[strlen($cut) - 1]) & 0xC0) === 0x80) {
        $cut = substr($cut, 0, -1);
    }
    return $cut;
}

/* ------------------------------------------------------------------ codes -- */

/**
 * 6 characters, no look-alikes.
 *
 * The code is spoken out loud or typed from a screen, so 0/O and 1/I/L are not
 * in the alphabet at all: a person cannot get them wrong if they are absent.
 */
const KSU_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function ksu_code_new(): string
{
    $out = '';
    for ($i = 0; $i < 6; $i++) {
        $out .= KSU_ALPHABET[random_int(0, strlen(KSU_ALPHABET) - 1)];
    }
    return $out;
}

/** Anything the client sends is checked before it ever touches a path. */
function ksu_code_ok(string $code): bool
{
    return (bool) preg_match('/^[2-9A-HJ-NP-Z]{6}$/', $code);
}

function ksu_code_require(): string
{
    $code = strtoupper(trim((string) ($_GET['code'] ?? '')));
    if (!ksu_code_ok($code)) {
        ksu_err(400, 'bad code');
    }
    return $code;
}

/* ------------------------------------------------------------------ paths -- */

function ksu_room_dir(string $code): string
{
    return KSU_DATA . '/rooms/' . $code;
}

function ksu_room_exists(string $code): bool
{
    return is_file(ksu_room_dir($code) . '/meta.json');
}

function ksu_room_make(): string
{
    // A collision is not an error worth a second try loop of its own: 30^6 is
    // about 7e8 combinations, and a busy host still has tens of thousands of
    // free slots. Three tries is plenty and keeps the endpoint simple.
    for ($try = 0; $try < 3; $try++) {
        $code = ksu_code_new();
        $dir = ksu_room_dir($code);
        if (is_dir($dir)) {
            continue;
        }
        if (!@mkdir($dir . '/parts', 0775, true)) {
            continue;
        }
        return $code;
    }
    ksu_err(500, 'cannot create room');
}

/* -------------------------------------------------------------------- i/o -- */

function ksu_read_json(string $file): ?array
{
    if (!is_file($file)) {
        return null;
    }
    $raw = @file_get_contents($file);
    if ($raw === false || $raw === '') {
        return null;
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : null;
}

/** Write through a temporary file, then rename: readers never see half a file. */
function ksu_write_json(string $file, array $data): bool
{
    $tmp = $file . '.' . getmypid() . '.' . mt_rand(1000, 9999) . '.tmp';
    $body = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($body === false) {
        return false;
    }
    if (@file_put_contents($tmp, $body) === false) {
        return false;
    }
    if (!@rename($tmp, $file)) {
        @unlink($tmp);
        return false;
    }
    return true;
}

/* --------------------------------------------------------------- snapshot -- */

/**
 * The entire shared state of a room, as one value.
 *
 * There is deliberately NO history and no per-event stream. The two phones
 * only ever need to know "where is the film and is it playing", and a value
 * that is always complete cannot be replayed, duplicated or applied twice.
 * `seq` exists for one reason: so a long-poll knows whether the value it is
 * about to return is newer than the one the phone already has.
 *
 * `at` is the SERVER millisecond at which the value was stored. `pt` is the
 * server millisecond at which the finger landed, as stated by the phone that
 * pressed (0 when the phone could not say). The receiving side adds (now - pt)
 * to the film position when playing, so a packet that spent 300 ms in flight
 * lands where the sender actually is now, not where he was when he pressed and
 * not where the server wrote it down a leg later.
 *
 * Both numbers are in the SERVER's units, which is the whole point: no phone
 * clock is ever compared with another phone's clock. A phone turns its own
 * timestamp into server units with the offset it measures on the same link
 * (see local-door-wise `skew` in web/app.js), and the server refuses a `pt`
 * that is not plausibly close to its own now.
 */
function ksu_snap_path(string $code): string
{
    return ksu_room_dir($code) . '/snap.json';
}

function ksu_snap_read(string $code): array
{
    $s = ksu_read_json(ksu_snap_path($code));
    if ($s === null) {
        return ['seq' => 0, 't' => 0, 'p' => 1, 'd' => 0, 'at' => 0, 'pt' => 0, 'by' => '', 'a' => ''];
    }
    return $s + ['seq' => 0, 't' => 0, 'p' => 1, 'd' => 0, 'at' => 0, 'pt' => 0, 'by' => '', 'a' => ''];
}

/**
 * Store a new snapshot and give it the next sequence number.
 *
 * The sequence number is assigned HERE, by the server, and never by a phone.
 * That is what makes "apply this once" safe: two presses can arrive out of
 * order over a bad link and the later number still wins, because the receiver
 * only accepts strictly increasing `seq`.
 */
function ksu_snap_store(string $code, int $t, int $p, int $d, string $by, string $a, int $pt = 0): array
{
    $file = ksu_snap_path($code);
    $lock = @fopen(ksu_room_dir($code) . '/snap.lock', 'c');
    if ($lock) {
        @flock($lock, LOCK_EX);
    }
    $prev = ksu_snap_read($code);
    $snap = [
        'seq' => ((int) ($prev['seq'] ?? 0)) + 1,
        't' => max(0, $t),
        'p' => $p ? 1 : 0,
        'd' => max(0, $d),
        'at' => ksu_now_ms(),
        'pt' => max(0, $pt),
        'by' => substr(preg_replace('/[^A-Za-z0-9_-]/', '', $by) ?? '', 0, 24),
        'a' => substr(preg_replace('/[^a-z]/', '', $a) ?? '', 0, 12),
    ];
    ksu_write_json($file, $snap);
    if ($lock) {
        @flock($lock, LOCK_UN);
        @fclose($lock);
    }
    return $snap;
}

/* ------------------------------------------------------------------ files -- */

function ksu_part_path(string $code, int $idx): string
{
    return ksu_room_dir($code) . sprintf('/parts/%05d.bin', $idx);
}

/* ------------------------------------------------------------------ sweep -- */

/**
 * Delete rooms nobody has touched for KSU_ROOM_TTL.
 *
 * Runs on a small fraction of requests so it costs nothing on average: a
 * shared host has no cron and a room that is never swept is a room that fills
 * the disk one film at a time.
 */
function ksu_sweep(): void
{
    if (mt_rand(1, 40) !== 1) {
        return;
    }
    $root = KSU_DATA . '/rooms';
    if (!is_dir($root)) {
        return;
    }
    $dead = time() - KSU_ROOM_TTL;
    foreach ((array) @scandir($root) as $name) {
        if (!is_string($name) || $name === '.' || $name === '..') {
            continue;
        }
        $dir = $root . '/' . $name;
        if (!ksu_code_ok($name) || !is_dir($dir)) {
            continue;
        }
        $stamp = @filemtime($dir . '/meta.json');
        if ($stamp !== false && $stamp > 0 && $stamp < $dead) {
            ksu_rmtree($dir);
        }
    }
}

function ksu_rmtree(string $dir): void
{
    foreach ((array) @scandir($dir) as $name) {
        if (!is_string($name) || $name === '.' || $name === '..') {
            continue;
        }
        $path = $dir . '/' . $name;
        if (is_dir($path)) {
            ksu_rmtree($path);
        } else {
            @unlink($path);
        }
    }
    @rmdir($dir);
}
