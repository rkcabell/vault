//File: apps/web/components/common/Sidebar.tsx

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, ChevronRight, Tag, BookmarkCheck, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from "@/components/ui/Button";
import { ScrollArea } from '@/ui/Scroll-Area';
import { Badge } from '@/ui/Badge';
import type { Route } from "next";

export interface TagItem {
  id: string;
  name: string;
  count?: number;
}

export interface SavedView {
  id: string;
  name: string;
  count?: number;
}

interface SidebarProps {
  tags?: TagItem[];
  savedViews?: SavedView[];
  isLoading?: boolean;
  className?: string;
}

interface SidebarSectionProps {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function SidebarSection({ title, icon, children, defaultOpen = true }: SidebarSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="mb-4">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'flex w-full items-center justify-between px-3 py-2 text-sm font-semibold',
          'rounded-md hover:bg-accent transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2">
          {icon}
          <span>{title}</span>
        </div>
        {isOpen ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
      </button>
      {isOpen && <div className="mt-1">{children}</div>}
    </div>
  );
}

export function Sidebar({ tags = [], savedViews = [], isLoading = false, className }: SidebarProps) {
  const pathname = usePathname();

  if (isLoading) {
    return (
      <aside className={cn('w-64 border-r bg-background', className)}>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </aside>
    );
  }

  return (
    <aside className={cn('w-64 border-r bg-background', className)}>
      <ScrollArea className="h-full py-4">
        <nav className="px-3 space-y-1">
          <SidebarSection
            title="Tags"
            icon={<Tag className="h-4 w-4" />}
          >
            {tags.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                No tags yet
              </div>
            ) : (
              <div className="space-y-1">
                {tags.map((tag) => {
                  const href = `/tags/${tag.id}`;
                  const isActive = pathname === href;

                  return (
                    <Link
                      key={tag.id}
                      href={href as Route}
                      className={cn(
                        'flex items-center justify-between px-3 py-2 text-sm rounded-md',
                        'transition-colors hover:bg-accent hover:text-accent-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isActive
                          ? 'bg-accent text-accent-foreground font-medium'
                          : 'text-muted-foreground'
                      )}
                    >
                      <span className="truncate">{tag.name}</span>
                      {tag.count !== undefined && (
                        <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-xs">
                          {tag.count}
                        </Badge>
                      )}
                    </Link>
                  );
                })}
              </div>
            )}
          </SidebarSection>

          <SidebarSection
            title="Saved Views"
            icon={<BookmarkCheck className="h-4 w-4" />}
          >
            {savedViews.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                No saved views
              </div>
            ) : (
              <div className="space-y-1">
                {savedViews.map((view) => {
                  const href = `/views/${view.id}`;
                  const isActive = pathname === href;

                  return (
                    <Link
                      key={view.id}
                      href={href as Route}
                      className={cn(
                        'flex items-center justify-between px-3 py-2 text-sm rounded-md',
                        'transition-colors hover:bg-accent hover:text-accent-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isActive
                          ? 'bg-accent text-accent-foreground font-medium'
                          : 'text-muted-foreground'
                      )}
                    >
                      <span className="truncate">{view.name}</span>
                      {view.count !== undefined && (
                        <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-xs">
                          {view.count}
                        </Badge>
                      )}
                    </Link>
                  );
                })}
              </div>
            )}
          </SidebarSection>
        </nav>
      </ScrollArea>
    </aside>
  );
}
