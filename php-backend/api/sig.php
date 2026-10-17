<?php
/**
 * Signalling: two phones introducing themselves so the BUTTON can skip the
 * server entirely.
 *
 * THE POINT. The film is already offline. The only thing that travels is a
 * press. Sending a press through this host costs one wide-area round trip
 * (measured: 280-660 ms on free hosting — a static stylesheet costs the same,
 * so it is the wire, not the code). A data channel between the two phones
 * costs what the hop between them costs: about a millisecond on the same
 * wi-fi, tens of milliseconds across a country.
 *
 * But two browsers cannot find each other without help. That is all this is:
 * a mailbox for the handful of SDP and ICE messages a WebRTC handshake needs.
 * Once the channel is open, no press touches this endpoint again — and if the
 * channel never opens (a network that will not allow it), the app carries on
 * exactly as it does today, through /api/state and /api/wait.
 *
 * Messages are files with the addressee's name on them, deleted as they are
 * handed over. They are small, they live for two minutes, and they are read by
 * nobody but the other phone.
 */

/** POST /api/sig?code=&who=&to= — one message for the other side. */
function ksu_sig_put(): void
{
    $code = ksu_code_require();
    if (!ksu_room_exists($code)) {
        ksu_err(404, 'no such room');
    }

    $who = ksu_name((string) ($_GET['who'] ?? ''));
    $to = ksu_name((string) ($_GET['to'] ?? ''));
    if ($who === '' || $to === '') {
        ksu_err(400, 'need who and to');
    }

    $body = json_decode((string) file_get_contents('php://input'), true);
    if (!is_array($body)) {
        ksu_err(400, 'bad json');
    }
    $kind = (string) ($body['kind'] ?? '');
    if ($kind !== 'offer' && $kind !== 'answer' && $kind !== 'ice') {
        ksu_err(400, 'kind');
    }

    // The payload is opaque here — the browser knows what SDP looks like, this
    // endpoint only has to carry it. Size-capped so a bad client cannot fill
    // the disk: an offer is a few KB, trickled candidates are tiny.
    $data = json_encode($body['data'] ?? null);
    if (!is_string($data) || strlen($data) > 20000) {
        ksu_err(400, 'too big');
    }

    $dir = ksu_room_dir($code) . '/sig';
    @mkdir($dir, 0775, true);

    // Ordered by arrival, and never overwritten: two candidates that share a
    // millisecond would clobber each other with a plain timestamp name.
    $name = sprintf('%016.0f', microtime(true) * 1000)
        . '-' . bin2hex(random_bytes(3))
        . '.' . $to . '.json';
    ksu_write_json($dir . '/' . $name, ['from' => $who, 'kind' => $kind, 'data' => $body['data'] ?? null]);

    // A handshake is a dozen messages. More than two hundred pending means
    // something is retrying in a loop; drop the oldest rather than the disk.
    $files = (array) @scandir($dir);
    if (count($files) > 200) {
        $old = array_slice(array_values(array_filter($files, static fn($f) => substr($f, -5) === '.json')), 0, 100);
        foreach ($old as $f) {
            @unlink($dir . '/' . $f);
        }
    }

    ksu_json(['ok' => true]);
}

/** GET /api/sig?code=&who= — everything addressed to me, and remove it. */
function ksu_sig_get(): void
{
    $code = ksu_code_require();
    if (!ksu_room_exists($code)) {
        ksu_err(404, 'no such room');
    }
    $who = ksu_name((string) ($_GET['who'] ?? ''));
    if ($who === '') {
        ksu_err(400, 'need who');
    }

    $dir = ksu_room_dir($code) . '/sig';
    $out = [];
    $cut = time() - 120;

    foreach ((array) @scandir($dir) as $f) {
        if (!is_string($f) || substr($f, -5) !== '.json') {
            continue;
        }
        // <time>-<rand>.<to>.json — the addressee is the part between the
        // first dot and the extension, so a name can never match a prefix by
        // accident.
        $parts = explode('.', $f);
        if (count($parts) < 3 || $parts[1] !== $who) {
            continue;
        }
        $path = $dir . '/' . $f;
        if (($mtime = @filemtime($path)) !== false && $mtime < $cut) {
            @unlink($path);                        // abandoned handshake
            continue;
        }
        $msg = ksu_read_json($path);
        @unlink($path);                            // handed over once
        if (is_array($msg)) {
            $out[] = $msg;
        }
    }

    ksu_json(['msgs' => $out, 'now' => ksu_now_ms()]);
}

/** A peer id: the app's own short id, nothing else allowed through. */
function ksu_name(string $v): string
{
    return substr((string) (preg_replace('/[^A-Za-z0-9_-]/', '', $v) ?? ''), 0, 24);
}
