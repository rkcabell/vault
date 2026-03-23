export { normalizeTag, normalizeTags, TagValidationError, TAG_RULES } from "@vault/types";
export type { TagValidationErrorCode } from "@vault/types";

export const TAGS_UPDATED_EVENT = "tags:updated";

export type TagsUpdatedDetail = {
  deletedTag?: string;
};

export function emitTagsUpdated(detail?: TagsUpdatedDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<TagsUpdatedDetail | undefined>(TAGS_UPDATED_EVENT, { detail }));
}
