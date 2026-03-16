import { z } from "zod";

// ---------------------------------------------------------------------------
// Tags  (GET /tags, POST /tags, DELETE /tags/:tag)
// ---------------------------------------------------------------------------

export const TagItemSchema = z.object({
  name: z.string(),
  count: z.number(),
});
export type TagItem = z.infer<typeof TagItemSchema>;

export const TagsListResponseSchema = z.object({
  tags: z.array(TagItemSchema),
});
export type TagsListResponse = z.infer<typeof TagsListResponseSchema>;

export const DeleteTagResponseSchema = z.object({
  ok: z.literal(true),
  tag: z.string(),
});
export type DeleteTagResponse = z.infer<typeof DeleteTagResponseSchema>;
