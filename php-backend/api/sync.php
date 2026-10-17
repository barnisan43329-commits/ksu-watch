<?php
/**
 * Sync: one value, one sequence number, one held request.
 *
 * Every button press stores a complete snapshot — position, playing, duration
 * — and the other side replaces its idea of the film with that snapshot. There
 * is no history, so a lost packet cannot be applied twice and a duplicated
 * packet cannot arrive "late but older": only a strictly greater `seq` counts.
 */

/** POST /api/state — a button was pressed. */
function ksu_state_put(): void
{
    $code = ksu_code_require();
    if (!ksu_room_exists($code)) {
        ksu_err(404, 'no such room');
    }
    $body = json_decode((string) file_get_contents('php://input'), true);
    if (!is_array($body)) {
        ksu_err(400, 'bad json');
    }

    $t = (int) round((float) ($body['t'] ?? 0));      // film position, milliseconds
    $p = (int) ($body['p'] ?? 0);                      // 1 = paused
    $d = (int) round((float) ($body['d'] ?? 0));       // film length, milliseconds
    $by = (string) ($body['by'] ?? '');
    $a = (string) ($body['a'] ?? '');                  // play | pause | seek | hello

    /* WHEN THE FINGER LANDED, IN SERVER TIME.
     *
     * `at` is when this request reached the server, which is AFTER the press
     * crossed the link — so a receiver that adds (its now - at) to the
     * position re-anchors at the server's store moment and starts the film one
     * up-leg behind the sender. On a free host that up-leg is 300-600 ms and
     * it is visible.
     *
     * The sending phone therefore states the press moment in the server's own
     * units (`pt` = its clock plus the offset it measured against this very
     * server). It is a hint, so it is never trusted blindly: a wild value —
     * a phone with no samples yet, a clock that jumped — is dropped and the
     * store time is used instead, which is the old, safe behaviour. */
    $pt = (int) round((float) ($body['pt'] ?? 0));
    if ($pt <= 0 || abs($pt - ksu_now_ms()) > 60000) {
        $pt = 0;
    }

    if ($t < 0) {
        $t = 0;
    }
    if ($d > 0 && $t > $d) {
        $t = $d;
    }

    $snap = ksu_snap_store($code, $t, $p ? 1 : 0, $d, $by, $a, $pt);
    ksu_json(['snap' => $snap, 'now' => ksu_now_ms()]);
}

/**
 * GET /api/wait?code=&after=&ms=
 *
 * HOLD the connection until the room's sequence number is greater than
 * `after`, then answer. A phone that is watching a film spends its whole time
 * inside this call, which is why a press reaches the other side in tens of
 * milliseconds instead of a polling interval — and why a minute of silence
 * costs one request rather than two hundred.
 *
 * `ms=0` turns it into an ordinary read, used by the fallback path on hosts
 * that will not hold a request open.
 */
function ksu_wait(): void
{
    $code = ksu_code_require();
    if (!ksu_room_exists($code)) {
        ksu_err(404, 'no such room');
    }
    $after = (int) ($_GET['after'] ?? 0);
    $ms = (int) ($_GET['ms'] ?? KSU_WAIT_MS);
    if ($ms < 0) {
        $ms = 0;
    }
    if ($ms > KSU_WAIT_MS) {
        $ms = KSU_WAIT_MS;
    }

    // Flush what we have and stop buffering: the phone should see the answer
    // the moment it is written, not when PHP feels like finishing.
    @ini_set('zlib.output_compression', '0');
    @ini_set('output_buffering', '0');
    while (ob_get_level() > 0) {
        @ob_end_flush();
    }

    $deadline = microtime(true) + ($ms / 1000.0);
    $snap = ksu_snap_read($code);

    // 12 ms between looks: a press written this instant is picked up within
    // one tick, and a phone waiting costs the host a few file reads a second
    // rather than a CPU core.
    while ((int) $snap['seq'] <= $after && microtime(true) < $deadline) {
        usleep(12000);
        clearstatcache(true, ksu_snap_path($code));
        $snap = ksu_snap_read($code);
    }

    ksu_json([
        'snap' => $snap,
        'now' => ksu_now_ms(),
        'idle' => ((int) $snap['seq'] <= $after),
    ]);
}
