<?php
/**
 * KsuNiMeet Watch — settings.
 *
 * Everything that a normal host would want to tune lives here and nowhere else.
 * The values below are chosen for a free 10 MB-per-request shared host
 * (InfinityFree and friends): a film is cut into 8 MB pieces and the sync
 * request is never held longer than the host allows.
 */

/** Where rooms live. Must be writable by PHP and must not be web-readable. */
const KSU_DATA = __DIR__ . '/data';

/**
 * Biggest piece of a film, in bytes.
 *
 * 8 MB, not 45: free shared hosting caps a single POST at 10 MB and the
 * request itself has to fit too. The player never sees these pieces — they are
 * glued back into one blob on the receiving phone — so the number is purely a
 * transport detail.
 */
const KSU_CHUNK = 8 * 1024 * 1024;

/**
 * How long one sync request may be held open, in milliseconds.
 *
 * This is the whole point of the backend: the guest does not ask "anything
 * new?" twice a second, it asks and WAITS, and the server answers in the same
 * millisecond a button is pressed. Too long and one phone occupies one PHP
 * worker for nothing; too short and the guest polls again more often.
 */
const KSU_WAIT_MS = 8000;

/** Rooms older than this are deleted on sight. */
const KSU_ROOM_TTL = 12 * 3600;

/** Bodies bigger than this are refused before reading them. */
const KSU_MAX_BODY = 12 * 1024 * 1024;

/** Turn error output into a JSON answer instead of a broken page. */
const KSU_DEBUG = false;
