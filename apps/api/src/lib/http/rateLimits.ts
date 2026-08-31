/**
 * Rate-limit buckets for the endpoints expensive enough to need one, kept in one
 * file so the whole set can be read at once. Each is per-account, so a runaway
 * client cannot stall the server for a second user. They are ceilings on retry
 * loops and held-down buttons, not quotas: using the UI never reaches one.
 */

/** Walks a root, possibly over SMB. Concurrency is capped at 1 in indexService,
 *  so this only catches a client retrying past that 409. */
export const INDEX_SCAN = { limit: 20, windowMs: 300_000 };

/** Same walk as a scan, plus a stat() per row it already has. */
export const RECONCILE = { limit: 20, windowMs: 300_000 };

/** Hashes every row that has no hash yet. */
export const DUPLICATES_SCAN = { limit: 10, windowMs: 300_000 };

/** Re-evaluates every rule against every row and rewrites the tags that changed. */
export const TAG_RULE_RUN = { limit: 20, windowMs: 300_000 };

/** Loops `clean` until the queue stops returning a full page. */
export const CLEAR_FAILED_JOBS = { limit: 20, windowMs: 300_000 };

/** Full-text search. Loose — the grid refetches on scroll, filter and SSE event. */
export const MEDIA_SEARCH = { limit: 600, windowMs: 60_000 };

/** Sending a file, and writing a blob. High enough that a bulk send of small
 *  files does not trip it; the per-file size limits bound the disk cost. */
export const STREAM_WRITE = { limit: 2000, windowMs: 60_000 };

/** Reads the whole library (export) or rewrites it (restore). Tightest bucket
 *  here: restore is serialized by a Redis lock and nothing beyond it. */
export const SIDECAR_SNAPSHOT = { limit: 5, windowMs: 300_000 };

/** Opens and zips a bounded set of originals, streaming for as long as that takes. */
export const BULK_DOWNLOAD = { limit: 30, windowMs: 300_000 };

/** Hand-picked re-queue: per id, a stale-job lookup on both text tiers and a write. */
export const DERIVATIVE_REQUEUE = { limit: 60, windowMs: 300_000 };

/** Claims a capped slice of the NEEDS_OCR backlog and queues a Tesseract run per row. */
export const EXTRACT_ALL_SCANNED = { limit: 10, windowMs: 300_000 };

/** Viewport promotion. Loose because the grid posts on every scroll settle — a
 *  ceiling on a runaway loop, not on a user. */
export const DERIVATIVE_PROMOTE = { limit: 600, windowMs: 60_000 };

/** The server-side folder picker: one readdir per click, plus the odd mkdir. */
export const SERVER_FS = { limit: 300, windowMs: 300_000 };
