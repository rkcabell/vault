"use client";

import { useEffect, useRef } from "react";

type UseInfiniteScrollOptions = {
  /** Whether another page exists (e.g. a non-null cursor). */
  hasMore: boolean;
  /** True while a page is already being fetched — suppresses re-triggers. */
  isLoading: boolean;
  /** Fetch the next page. Guarded against double-fires. */
  onLoadMore: () => void;
  /**
   * Extra viewport margin (px) so loading starts before the sentinel is
   * visible. Defaults to 600.
   */
  rootMargin?: number;
};

/**
 * Scroll-triggered pagination: returns a ref to attach to a sentinel element
 * rendered after the list. When the sentinel nears the viewport and more pages
 * exist, `onLoadMore` fires. Lifted from the AddMediaDialog/Sidebar
 * IntersectionObserver pattern.
 *
 * The observer is torn down while a fetch is in flight and re-created when it
 * finishes — a fresh `observe()` always reports the current intersection, so if
 * the sentinel is still in view after a short page, the next load fires without
 * needing another scroll (plain observers only fire on crossings and would
 * stall). `firedRef` covers the gap between calling `onLoadMore` and the
 * parent re-rendering with `isLoading` true; the callback lives in a ref so
 * inline closures never re-create the observer.
 */
export function useInfiniteScroll({ hasMore, isLoading, onLoadMore, rootMargin = 600 }: UseInfiniteScrollOptions) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(onLoadMore);
  const firedRef = useRef(false);

  useEffect(() => {
    loadMoreRef.current = onLoadMore;
  });

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || isLoading) return;
    firedRef.current = false;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0]?.isIntersecting && !firedRef.current) {
          firedRef.current = true;
          loadMoreRef.current();
        }
      },
      { threshold: 0, rootMargin: `${rootMargin}px` },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoading, rootMargin]);

  return sentinelRef;
}
