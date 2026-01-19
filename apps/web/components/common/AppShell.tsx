//File: apps/web/components/common/AppShell.tsx
"use client"

import { useCallback, useEffect, useState } from 'react';
import { TopNav } from './TopNav';
import { Sidebar, type TagItem, type SavedView } from './Sidebar';
import { Sheet, SheetContent } from '@/components/ui/Sheet';
import { TAGS_UPDATED_EVENT } from '@/lib/tags';

interface AppShellProps {
  children: React.ReactNode;
  tags?: TagItem[];
  savedViews?: SavedView[];
  isLoadingSidebar?: boolean;
  showSidebar?: boolean;
}

export function AppShell({
  children,
  tags = [],
  savedViews = [],
  isLoadingSidebar = false,
  showSidebar = true,
}: AppShellProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarTags, setSidebarTags] = useState<TagItem[]>(tags);
  const [isFetchingTags, setIsFetchingTags] = useState(false);

  useEffect(() => {
    setSidebarTags(tags);
  }, [tags]);

  const fetchSidebarTags = useCallback(async () => {
    setIsFetchingTags(true);
    try {
      const res = await fetch("/api/tags", { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as { tags?: { name: string; count: number }[] };
      if (!data?.tags) return;
      setSidebarTags(
        data.tags.map(t => ({
          id: t.name,
          name: t.name,
          count: t.count,
        })),
      );
    } finally {
      setIsFetchingTags(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchSidebarTags().catch(() => {});
    const handler = () => {
      if (cancelled) return;
      void fetchSidebarTags().catch(() => {});
    };
    window.addEventListener(TAGS_UPDATED_EVENT, handler);
    return () => {
      cancelled = true;
      window.removeEventListener(TAGS_UPDATED_EVENT, handler);
    };
  }, [fetchSidebarTags]);

  return (
    <div className="flex h-screen flex-col">
      <TopNav onMenuClick={() => setMobileMenuOpen(true)} />

      <div className="flex flex-1 overflow-hidden">
        {showSidebar && (
          <>
            <div className="hidden lg:block">
              <Sidebar
                tags={sidebarTags}
                savedViews={savedViews}
                isLoading={isLoadingSidebar || isFetchingTags}
              />
            </div>

            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetContent side="left" className="p-0 w-64">
                <Sidebar
                  tags={sidebarTags}
                  savedViews={savedViews}
                  isLoading={isLoadingSidebar || isFetchingTags}
                />
              </SheetContent>
            </Sheet>
          </>
        )}

        <main className="flex-1 overflow-y-auto">
          <div className="h-full">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
