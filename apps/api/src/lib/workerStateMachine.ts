/**
 * Central definition of valid MediaWorkerState transitions.
 *
 * Enforcement happens at the database layer via conditional WHERE clauses in
 * updateMany calls (see MediaRepository). Using WHERE instead of application-
 * level guards makes the checks atomic and race-condition safe: a late-arriving
 * worker can never overwrite a terminal state written by a cancel/retry path.
 *
 * Valid transitions:
 *
 *   thumbState
 *     PENDING → READY        (worker success)
 *     PENDING → FAILED       (worker render error)
 *     PENDING → FAILED       (stall detection)
 *     PENDING → UNSUPPORTED  (type can't be thumbnailed)
 *     FAILED  → (none)       terminal — thumbnail is one-shot; no re-run path exists
 *     UNSUPPORTED → (none)   terminal — file is intrinsically not thumbnailable
 *
 *   textState
 *     PENDING → READY        (worker success)
 *     PENDING → ERROR        (worker non-transient failure or exhausted retries)
 *     PENDING → ERROR        (stall detection)
 *     PENDING → UNSUPPORTED  (mime can't produce text, or too large)
 *     READY   → PENDING      (user re-runs extraction)
 *     ERROR   → PENDING      (user re-runs extraction)
 *     UNSUPPORTED → (none)   terminal — file is intrinsically not extractable
 *
 * FAILED is used exclusively for thumbState (real render failures).
 * ERROR  is used exclusively for textState (real extraction failures).
 * UNSUPPORTED is shared by both: a terminal "won't process" state for files that are
 *   the wrong type or too large. It is never retried, and the human-readable reason is
 *   surfaced to the UI (thumbError for thumbnails; a derived reason for text).
 */

/** How long a record may remain at PENDING before stall detection marks it terminal. */
export const STALL_THRESHOLD_MINUTES = 15;
