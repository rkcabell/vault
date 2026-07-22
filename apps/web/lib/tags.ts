export { normalizeTag, normalizeTags, tagNamespace, TagValidationError, TAG_RULES } from "@vault/types";
export type { TagValidationErrorCode, TagOrigin } from "@vault/types";

import type { TagOrigin } from "@vault/types";
import { getAppInitData } from "@/hooks/useAppInit";

/** Stable group: user-made items before auto items, original order preserved. */
export function partitionTagsByOrigin<T>(items: T[], isAuto: (item: T) => boolean): T[] {
  const user: T[] = [];
  const auto: T[] = [];
  for (const item of items) (isAuto(item) ? auto : user).push(item);
  return [...user, ...auto];
}

/** Order tags user-before-auto, each group alphabetical. `isAuto` is supplied
 *  per context (per-item `autoTags` lookup, or {@link tagOriginFromStore}). */
export function orderTagsByOrigin(tags: string[], isAuto: (tag: string) => boolean): string[] {
  return partitionTagsByOrigin([...tags].sort((a, b) => a.localeCompare(b)), isAuto);
}

/**
 * Name-level origin from the global tag store (seeded by /api/init, top tags).
 * Returns undefined when the tag isn't in the store, in which case callers should
 * treat it as user-made (the bolder default).
 */
export function tagOriginFromStore(name: string): TagOrigin | undefined {
  return getAppInitData()?.tags.find(t => t.name === name)?.origin;
}

/** Convenience predicate: is this tag AUTO according to the global store? */
export function isAutoTagFromStore(name: string): boolean {
  return tagOriginFromStore(name) === "AUTO";
}

export const TAGS_UPDATED_EVENT = "tags:updated";

export type TagsUpdatedDetail = {
  deletedTag?: string;
};

export function emitTagsUpdated(detail?: TagsUpdatedDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<TagsUpdatedDetail | undefined>(TAGS_UPDATED_EVENT, { detail }));
}
