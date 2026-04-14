import type { BundleMediaItem } from "@vault/types";
import type { MediaWorkerState } from "@/lib/media/types";

export const BUNDLES_UPDATED_EVENT = "bundles:updated";

export function emitBundlesUpdated() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(BUNDLES_UPDATED_EVENT));
}

export function toMediaItem(item: BundleMediaItem) {
  return {
    id:         item.mediaId,
    title:      item.title,
    thumbState: item.thumbState as MediaWorkerState,
    textState:  item.textState as MediaWorkerState,
    mimeType:   item.mimeType,
  };
}
