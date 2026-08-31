/**
 * The URL parameter shape shared by the media routes.
 */
import { z } from "zod";

/**
 * The `:id` parameter every media route reads.
 *
 * Parsing throws, so a malformed id is answered as a server error. The
 * thumbnail route in content.ts deliberately checks it without throwing and
 * serves a placeholder image instead, so one bad id cannot break a grid.
 */
export const paramsSchema = z.object({ id: z.string().uuid() }).strict();
