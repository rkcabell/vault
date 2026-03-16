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
 *     PENDING → READY   (worker success)
 *     PENDING → FAILED  (worker render error)
 *     PENDING → FAILED  (stall detection)
 *     FAILED  → (none)  terminal — thumbnail is one-shot; no re-run path exists
 *
 *   textState
 *     PENDING → READY   (worker success)
 *     PENDING → ERROR   (worker non-transient failure or exhausted retries)
 *     PENDING → ERROR   (stall detection)
 *     READY   → PENDING (user re-runs extraction)
 *     ERROR   → PENDING (user re-runs extraction)
 *
 * FAILED is used exclusively for thumbState (render failures).
 * ERROR  is used exclusively for textState (extraction failures).
 */

/** How long a record may remain at PENDING before stall detection marks it terminal. */
export const STALL_THRESHOLD_MINUTES = 15;
