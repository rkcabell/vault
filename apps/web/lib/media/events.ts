/**
 * Cross-component signal that the media *list* changed (items created or
 * deleted) — the media counterpart of TAGS_UPDATED_EVENT / BUNDLES_UPDATED_EVENT.
 * The library grid listens and silently refetches; emitters are every mutation
 * that changes list membership (delete completion, purge, upload, unpack).
 * Same-tab only — cross-tab updates arrive via the SSE stream instead.
 */

export const MEDIA_LIST_UPDATED_EVENT = "media:list-updated";

export type MediaListUpdatedDetail = {
  /** Ids known to be gone — lets listeners drop them optimistically before the refetch lands. */
  removedIds?: string[];
};

export function emitMediaListUpdated(detail?: MediaListUpdatedDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<MediaListUpdatedDetail>(MEDIA_LIST_UPDATED_EVENT, { detail }));
}
