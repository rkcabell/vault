// File: apps/web/components/common/AppShell.tsx
"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { TopNav } from "./TopNav";
import { Sidebar, type TagItem, type SavedView } from "./Sidebar";
import { Sheet, SheetContent } from "@/components/ui/Sheet";
import { TAGS_UPDATED_EVENT } from "@/lib/tags";
import { BUNDLES_UPDATED_EVENT } from "@/lib/bundles";

interface AppShellProps {
  children: React.ReactNode;
  tags?: TagItem[] | null;
  savedViews?: SavedView[] | null;
  isLoadingSidebar?: boolean;
  showSidebar?: boolean;
}

export function AppShell({
  children,
  tags = null,
  savedViews = null,
  isLoadingSidebar = false,
  showSidebar = true,
}: AppShellProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarTags, setSidebarTags] = useState<TagItem[] | null>(tags);
  const [isFetchingTags, setIsFetchingTags] = useState(false);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const tagsAbortRef = useRef<AbortController | null>(null);
  const [sidebarBundles, setSidebarBundles] = useState<SavedView[] | null>(savedViews);
  const bundlesAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setSidebarTags(tags);
  }, [tags]);

  const fetchSidebarTags = useCallback(async () => {
    tagsAbortRef.current?.abort();
    const controller = new AbortController();
    tagsAbortRef.current = controller;
    setIsFetchingTags(true);
    setTagsError(null);
    try {
      const res = await fetch("/api/tags", {
        credentials: "include",
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Unable to load tags (${res.status})`);
      }
      const data = (await res.json().catch(() => null)) as
        | { tags?: { name: string; count: number }[] }
        | null;
      if (!data?.tags) {
        throw new Error("Unable to load tags.");
      }
      if (tagsAbortRef.current !== controller) return;
      setSidebarTags(
        data.tags.map(t => ({
          id: t.name,
          name: t.name,
          count: t.count,
        })),
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      setTagsError(err instanceof Error ? err.message : "Unable to load tags.");
    } finally {
      if (tagsAbortRef.current === controller && !controller.signal.aborted) {
        setIsFetchingTags(false);
      }
    }
  }, []);

  useEffect(() => {
    void fetchSidebarTags().catch(() => {});
    const handler = () => {
      void fetchSidebarTags().catch(() => {});
    };
    window.addEventListener(TAGS_UPDATED_EVENT, handler);
    return () => {
      window.removeEventListener(TAGS_UPDATED_EVENT, handler);
      tagsAbortRef.current?.abort();
    };
  }, [fetchSidebarTags]);

  const fetchSidebarBundles = useCallback(async () => {
    bundlesAbortRef.current?.abort();
    const controller = new AbortController();
    bundlesAbortRef.current = controller;
    try {
      const res = await fetch("/api/bundles", {
        credentials: "include",
        signal: controller.signal,
      });
      if (!res.ok) return;
      const data = (await res.json().catch(() => null)) as
        | { bundles?: { id: string; name: string; itemCount: number }[] }
        | null;
      if (!data?.bundles || bundlesAbortRef.current !== controller) return;
      setSidebarBundles(
        data.bundles.map(b => ({ id: b.id, name: b.name, count: b.itemCount })),
      );
    } catch {
      // aborted or error — sidebar just stays empty
    }
  }, []);

  useEffect(() => {
    void fetchSidebarBundles().catch(() => {});
    const handler = () => { void fetchSidebarBundles().catch(() => {}); };
    window.addEventListener(BUNDLES_UPDATED_EVENT, handler);
    return () => {
      window.removeEventListener(BUNDLES_UPDATED_EVENT, handler);
      bundlesAbortRef.current?.abort();
    };
  }, [fetchSidebarBundles]);

  return (
    <div className="flex h-screen flex-col">
      <TopNav onMenuClick={() => setMobileMenuOpen(true)} />

      <div className="flex flex-1 overflow-hidden">
        {showSidebar && (
          <>
            <div className="hidden lg:block">
              <Suspense fallback={null}>
                <Sidebar
                  tags={sidebarTags}
                  savedViews={sidebarBundles}
                  tagsError={tagsError}
                  isLoading={isLoadingSidebar || isFetchingTags}
                />
              </Suspense>
            </div>

            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetContent side="left" className="p-0 w-64">
                <Suspense fallback={null}>
                  <Sidebar
                    tags={sidebarTags}
                    savedViews={sidebarBundles}
                    tagsError={tagsError}
                    isLoading={isLoadingSidebar || isFetchingTags}
                  />
                </Suspense>
              </SheetContent>
            </Sheet>
          </>
        )}

        <main className="flex-1 overflow-y-auto">
          <div className="h-full">{children}</div>
        </main>
      </div>
    </div>
  );
}
