export const BUNDLES_UPDATED_EVENT = "bundles:updated";

export function emitBundlesUpdated() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(BUNDLES_UPDATED_EVENT));
}
