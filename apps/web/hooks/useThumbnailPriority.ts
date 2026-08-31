"use client";

import { useEffect, useRef } from "react";
import { apiFetch } from "@/lib/apiFetch";

/**
 * Tells the API which pending thumbnails are on screen.
 *
 * After indexing a folder the library is a wall of placeholders with tens of
 * thousands of rows waiting behind them. The user is looking at forty. The
 * server-side feeder recomputes its claim order every tick, so the only thing
 * missing was somebody telling it what "on screen" means — that is this hook.
 *
 * It observes the cards that mark themselves `data-thumb-pending="true"` and
 * posts the intersecting ids after a scroll settles. Purely an ordering hint:
 * the endpoint re-generates nothing, so a dropped or duplicated call costs
 * nothing beyond a slightly later thumbnail.
 */

/** Long enough that a flick through several screens sends one request rather
 *  than one per frame; short enough to feel like a reaction to stopping. */
const SETTLE_MS = 400;

/** A viewport is tens of cards. The cap is a guard against a pathological
 *  zoomed-out grid, and matches the route's own batch limit. */
const MAX_IDS = 200;

export function useThumbnailPriority (
  containerRef: React.RefObject<HTMLElement | null>,
  /** Anything that changes the rendered set — the items array is the usual one.
   *  Re-observation is driven off this rather than off DOM mutation. */
  itemsKey: unknown,
) {
  // Ids already sent. The set of pending cards on screen barely changes while
  // the user reads, and re-posting the same forty ids every settle would be
  // pure noise — the promotion is idempotent but the request is not free.
  const sent = useRef<Set<string>>(new Set());

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof IntersectionObserver === "undefined") return;

    const visible = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      const ids = [...visible].filter(id => !sent.current.has(id)).slice(0, MAX_IDS);
      if (ids.length === 0) return;
      for (const id of ids) sent.current.add(id);

      void apiFetch("/api/media/batch/thumbnail/prioritize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      }).catch(() => {
        // Best-effort ordering hint. Allow a retry on the next settle rather
        // than leaving these ids permanently marked as sent.
        for (const id of ids) sent.current.delete(id);
      });
    };

    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.mediaId;
        if (!id) continue;
        if (entry.isIntersecting) visible.add(id);
        else visible.delete(id);
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, SETTLE_MS);
    // rootMargin pulls in the row just below the fold, so the thumbnail is
    // usually there by the time the user scrolls to it.
    }, { root: null, rootMargin: "200px 0px", threshold: 0 });

    for (const el of container.querySelectorAll<HTMLElement>('[data-thumb-pending="true"]')) {
      observer.observe(el);
    }

    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, [containerRef, itemsKey]);
}
