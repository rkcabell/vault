// File: apps/web/components/common/AppShell.tsx
"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { TopNav } from "./TopNav";
import { Sidebar, type TagItem, type SavedView } from "./Sidebar";
import { Sheet, SheetContent } from "@/components/ui/Sheet";
import { TAGS_UPDATED_EVENT } from "@/lib/tags";
import { ThemeApplier } from "./ThemeApplier";
import { useAppInit } from "@/hooks/useAppInit";
import { cn } from "@/lib/utils";

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [tabPulsing, setTabPulsing] = useState(false);
  const [sidebarTags, setSidebarTags] = useState<TagItem[] | null>(tags);
  const [isFetchingTags, setIsFetchingTags] = useState(false);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const tagsAbortRef = useRef<AbortController | null>(null);
  const [sidebarBundles, setSidebarBundles] = useState<SavedView[] | null>(savedViews);

  const { data: initData, isLoaded: initLoaded } = useAppInit();

  // Seed sidebar from the batched init response.
  useEffect(() => {
    if (!initLoaded) return;
    if (initData) {
      setSidebarTags(initData.tags.map(t => ({ id: t.name, name: t.name, count: t.count, color: t.color })));
      setSidebarBundles(initData.bundles.map(b => ({ id: b.id, name: b.name, count: b.itemCount, starred: b.starred })));
    } else {
      // Init failed — fall back to individual tag fetch (bundles self-fetch in Sidebar).
      void fetchSidebarTags().catch(() => {});
    }
  }, [initLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

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
        | { tags?: { name: string; count: number; color: string | null }[] }
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
          color: t.color,
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

  // Refresh tags when a mutation signals an update.
  useEffect(() => {
    const handler = () => { void fetchSidebarTags().catch(() => {}); };
    window.addEventListener(TAGS_UPDATED_EVENT, handler);
    return () => {
      window.removeEventListener(TAGS_UPDATED_EVENT, handler);
      tagsAbortRef.current?.abort();
    };
  }, [fetchSidebarTags]);

  return (
    <div className="flex h-screen flex-col">
      <ThemeApplier />
      <TopNav onMenuClick={() => setMobileMenuOpen(true)} />

      <div className="flex flex-1 overflow-hidden relative">
        {showSidebar && (
          <>
            {/* Desktop sidebar — absolute overlay, floats above page content */}
            <div
              className="hidden lg:block absolute left-0 top-0 bottom-0 z-20"
              style={{
                transform: sidebarCollapsed ? "translateX(-256px)" : "translateX(0)",
                transition: "transform 300ms ease-in-out",
              }}
            >
              <Suspense fallback={null}>
                <Sidebar
                  tags={sidebarTags}
                  savedViews={sidebarBundles}
                  tagsError={tagsError}
                  isLoading={isLoadingSidebar || isFetchingTags}
                />
              </Suspense>
            </div>

            {/* Collapse tab — tracks sidebar's right edge */}
            <button
              onClick={() => {
                setSidebarCollapsed(c => !c);
                setTabPulsing(true);
                setTimeout(() => setTabPulsing(false), 250);
              }}
              className={cn(
                "hidden lg:flex absolute top-6 z-20 h-[42px] w-[30px] items-center justify-center border border-l-0 border-border shadow-sm transition-colors duration-150",
                tabPulsing
                  ? "bg-foreground text-background"
                  : "bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
              style={{
                left: sidebarCollapsed ? 0 : 256,
                transition: "left 300ms ease-in-out",
                borderRadius: "0 10px 10px 0",
              }}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <ChevronLeft
                className="h-3.5 w-3.5"
                style={{
                  transform: sidebarCollapsed ? "rotate(180deg)" : "rotate(0deg)",
                  transition: "transform 300ms ease-in-out",
                }}
              />
            </button>

            {/* Mobile sidebar */}
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
