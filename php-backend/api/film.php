<?php
/**
 * Film transport: the host's file goes up in pieces, the guest pulls the very
 * same bytes back. Nothing is transcoded, nothing is streamed, and no frame of
 * the film ever crosses the network while it is being watched.
 */

/** POST /api/film — what the pieces are called and how many there are. */
function ksu_film_put(): void
{
    $code = ksu_code_require();
    if (!ksu_room_exists($code)) {
        ksu_err(404, 'no such room');
    }

    $body = json_decode((string) file_get_contents('php://input'), true);
    if (!is_array($body)) {
        ksu_err(400, 'bad json');
    }

    $name = trim((string) ($body['name'] ?? ''));
    $size = (int) ($body['size'] ?? 0);
    $parts = (int) ($body['parts'] ?? 0);
    // The receiving phone glues the pieces back into a Blob. Without the type
    // a WebM is handed to the decoder as MP4 and simply refuses to open.
    // "video/mp4" — the slash is part of the value, so it survives the filter;
    // without it the type becomes "videomp4" and the phone refuses the film.
    $type = substr(preg_replace('#[^A-Za-z0-9/+.\-]#', '', (string) ($body['type'] ?? '')) ?? '', 0, 60);

    if ($name === '' || $size <= 0 || $parts <= 0) {
        ksu_err(400, 'need name, size, parts');
    }
    if ($parts > 20000) {
        ksu_err(400, 'too many parts');
    }

    $dir = ksu_room_dir($code);
    @mkdir($dir . '/parts', 0775, true);

    $meta = ksu_read_json($dir . '/meta.json') ?? ['code' => $code, 'created' => ksu_now_ms()];
    $meta['film'] = [
        // Cut on a character boundary, not a byte: a Cyrillic or Chinese name
        // sliced mid-character is a broken glyph on the other phone.
        'name' => ksu_cut($name, 120),
        'size' => $size,
        'parts' => $parts,
        'chunk' => KSU_CHUNK,
        'type' => $type,
        'at' => ksu_now_ms(),
    ];
    ksu_write_json($dir . '/meta.json', $meta);

    ksu_json(['ok' => true, 'parts' => $parts, 'chunk' => KSU_CHUNK]);
}

/**
 * POST /api/part?code=&idx= — one piece, raw body.
 *
 * Raw body rather than multipart: no boundary parsing, no temp file of the
 * PHP upload machinery, and a free host's `upload_max_filesize` stays out of
 * the way as long as `post_max_size` is above the piece.
 */
function ksu_part_put(): void
{
    $code = ksu_code_require();
    if (!ksu_room_exists($code)) {
        ksu_err(404, 'no such room');
    }
    $idx = (int) ($_GET['idx'] ?? -1);
    if ($idx < 0 || $idx > 20000) {
        ksu_err(400, 'bad idx');
    }
    $len = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($len <= 0) {
        ksu_err(400, 'empty piece');
    }
    if ($len > KSU_MAX_BODY) {
        ksu_err(413, 'piece too big');
    }

    $path = ksu_part_path($code, $idx);
    $in = fopen('php://input', 'rb');
    $out = @fopen($path . '.tmp', 'wb');
    if (!$in || !$out) {
        ksu_err(500, 'cannot store piece');
    }
    stream_copy_to_stream($in, $out);
    fclose($in);
    fclose($out);
    $got = (int) @filesize($path . '.tmp');
    if ($got !== $len) {
        @unlink($path . '.tmp');
        ksu_err(500, 'short write');
    }
    @rename($path . '.tmp', $path);
    ksu_json(['ok' => true, 'idx' => $idx, 'size' => $got]);
}

/** GET /api/part?code=&idx= — the same bytes back. */
function ksu_part_get(): void
{
    $code = ksu_code_require();
    $idx = (int) ($_GET['idx'] ?? -1);
    if ($idx < 0) {
        ksu_err(400, 'bad idx');
    }
    $path = ksu_part_path($code, $idx);
    if (!is_file($path)) {
        ksu_err(404, 'no such piece');
    }
    $size = (int) @filesize($path);

    header('Content-Type: application/octet-stream');
    header('Content-Length: ' . $size);
    // No caching anywhere: a finished room is deleted, and a stale piece from
    // a different film with the same code would be worse than a slow download.
    header('Cache-Control: no-store');
    header('Content-Transfer-Encoding: binary');
    readfile($path);
    exit;
}
