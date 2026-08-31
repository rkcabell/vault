/**
 * Records which changes of `thumbState` and `textState` a worker is allowed to
 * make, and how long a job may sit unfinished before it is given up on.
 *
 * The rules below are enforced by conditional WHERE clauses on the update
 * statements in MediaRepository, not by any check in this file.
 *
 * thumbState
 *   PENDING     → READY        worker rendered a thumbnail
 *   PENDING     → FAILED       render error, or the job never reported back
 *   PENDING     → UNSUPPORTED  the type cannot be rendered, or the file is too large
 *   any         → PENDING      the user asked for a fresh render, or a watched file changed
 *
 * textState
 *   PENDING     → READY        text was extracted
 *   PENDING     → ERROR        extraction failed, or the job never reported back
 *   PENDING     → UNSUPPORTED  the type produces no text, or the file is too large
 *   PENDING     → NEEDS_OCR    the fast pass found no text, so the file is set aside for OCR
 *   NEEDS_OCR   → READY|ERROR  an OCR run finished a file that had been set aside
 *   NEEDS_OCR   → PENDING      an OCR run was started for a file that had been set aside
 *   READY|ERROR → PENDING      the user asked for extraction to run again
 *
 * FAILED belongs to thumbnails and ERROR to text; the two never appear on the
 * other column. UNSUPPORTED is shared, and means the work will never be
 * attempted rather than that it failed. `hashState` and `sourceState` use the
 * same set of values but are not part of the rules above.
 */

/** How long a record may remain at PENDING before stall detection marks it terminal. */
export const STALL_THRESHOLD_MINUTES = 15;
