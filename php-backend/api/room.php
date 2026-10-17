<?php
/** Rooms: create one, read what is in it. */

/**
 * A room is created empty. The host creates it, then picks a film, and the
 * rest of the app is driven by what is in the room rather than by who clicked
 * what first: the guest joins, sees a film appear, downloads it and the player
 * comes up on its own.
 */
function ksu_room_create(): void
{
    $code = ksu_room_make();
    ksu_write_json(ksu_room_dir($code) . '/meta.json', [
        'code' => $code,
        'created' => ksu_now_ms(),
        'film' => null,
        'people' => [],
    ]);
    // An empty snapshot at seq 0: "paused at the start, nothing known yet".
    ksu_write_json(ksu_snap_path($code), [
        'seq' => 0, 't' => 0, 'p' => 1, 'd' => 0, 'at' => ksu_now_ms(), 'pt' => 0, 'by' => '', 'a' => '',
    ]);
    ksu_json(['code' => $code, 'now' => ksu_now_ms()]);
}

function ksu_room_get(): void
{
    $code = ksu_code_require();
    if (!ksu_room_exists($code)) {
        ksu_err(404, 'no such room');
    }
    $meta = ksu_read_json(ksu_room_dir($code) . '/meta.json') ?? [];

    // Presence is a file per person, touched on every look. It is not part of
    // the sync at all — nobody moves because somebody arrived — it only feeds
    // the "1 person here / 2 people here" line.
    $who = preg_replace('/[^A-Za-z0-9_-]/', '', (string) ($_GET['who'] ?? '')) ?? '';
    $people = [];
    $dir = ksu_room_dir($code) . '/people';
    if ($who !== '') {
        @mkdir($dir, 0775, true);
        @touch($dir . '/' . substr($who, 0, 24) . '.txt');
    }
    $cut = time() - 30;
    foreach ((array) @scandir($dir) as $f) {
        if (!is_string($f) || substr($f, -4) !== '.txt') {
            continue;
        }
        $p = $dir . '/' . $f;
        $mtime = @filemtime($p);
        if ($mtime !== false && $mtime >= $cut) {
            $people[] = substr($f, 0, -4);
        } else {
            @unlink($p);
        }
    }

    ksu_json([
        'code' => $code,
        'now' => ksu_now_ms(),
        'film' => $meta['film'] ?? null,
        'people' => count($people),
        // The ids themselves, not just how many: the two phones need to name
        // each other to open a data channel, and a press that skips the server
        // is the difference between 500 ms and 5 ms.
        'ids' => $people,
    ]);
}
