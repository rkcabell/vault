//File: apps/web/components/common/AppShell.tsx
"use client"

import { useState } from 'react';
import { TopNav } from './TopNav';
import { Sidebar, type TagItem, type SavedView } from './Sidebar';
import { Sheet, SheetContent } from '@/components/ui/Sheet';

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

  return (
    <div className="flex h-screen flex-col">
      <TopNav onMenuClick={() => setMobileMenuOpen(true)} />

      <div className="flex flex-1 overflow-hidden">
        {showSidebar && (
          <>
            <div className="hidden lg:block">
              <Sidebar
                tags={tags}
                savedViews={savedViews}
                isLoading={isLoadingSidebar}
              />
            </div>

            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetContent side="left" className="p-0 w-64">
                <Sidebar
                  tags={tags}
                  savedViews={savedViews}
                  isLoading={isLoadingSidebar}
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
