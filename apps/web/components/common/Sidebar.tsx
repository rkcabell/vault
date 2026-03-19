//File: apps/web/components/common/Sidebar.tsx

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown, ChevronRight, Tag, Folder, Loader2, Plus, MoreVertical, Trash } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/ui/ScrollArea';
import { Badge } from '@/ui/Badge';
import type { Route } from "next";
import { emitTagsUpdated } from '@/lib/tags';
import { ConfirmPopover } from '@/components/ui/ConfirmPopover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/DropdownMenu';

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
  tags?: TagItem[] | null;
  savedViews?: SavedView[] | null;
  tagsError?: string | null;
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

export function Sidebar({ tags, savedViews, tagsError, isLoading = false, className }: SidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{ x: number; y: number; tag: string } | null>(null);

  const activeTag = useMemo(() => {
    const tagParam = searchParams.get("tag")?.trim() || "";
    if (tagParam) return tagParam;

    const tagsParam = searchParams.get("tags") || "";
    const firstTag = tagsParam
      .split(",")
      .map(t => t.trim())
      .find(Boolean);
    return firstTag || "";
  }, [searchParams]);

  const selectTag = (tag: string) => {
    const params = new URLSearchParams(searchParams.toString());

    params.delete("tags");
    if (activeTag === tag) params.delete("tag");
    else params.set("tag", tag);

    const targetPath = pathname.startsWith("/library") ? pathname : "/library";
    const qs = params.toString();
    router.push((qs ? `${targetPath}?${qs}` : targetPath)as Route);
  };

  const requestDeleteTag = (tag: string, e: React.MouseEvent) => {
    if (deletingTag) return;
    setConfirmState({ x: e.clientX, y: e.clientY, tag });
  };

  const handleDeleteTag = async (tag: string) => {
    setDeletingTag(tag);
    try {
      const res = await fetch(`/api/tags/${encodeURIComponent(tag)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) return;
      emitTagsUpdated({ deletedTag: tag });
    } finally {
      setDeletingTag(null);
    }
  };

  if (isLoading) {
    return (
      <aside className={cn('w-64 h-full border-r bg-background rounded-b-2xl', className)}>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </aside>
    );
  }

  return (
    <aside className={cn('w-64 h-full border-r bg-background rounded-b-2xl', className)}>
      <ConfirmPopover
        open={confirmState !== null}
        x={confirmState?.x ?? 0}
        y={confirmState?.y ?? 0}
        message={`Delete tag "${confirmState?.tag}"? This will remove it from all media.`}
        onConfirm={() => { const tag = confirmState!.tag; setConfirmState(null); void handleDeleteTag(tag); }}
        onCancel={() => setConfirmState(null)}
      />
      <ScrollArea className="h-full py-4">
        <nav className="px-3 space-y-1">
          <SidebarSection
            title="Tags"
            icon={<Tag className="h-4 w-4" suppressHydrationWarning />}
          >
            <div className="space-y-2">
              <button
                type="button"
                disabled
                className={cn(
                  'flex w-full items-center gap-2 rounded-md border border-dashed border-muted-foreground/40 px-3 py-2 text-sm text-muted-foreground',
                  'cursor-not-allowed opacity-50'
                )}
              >
                <Plus className="h-4 w-4" />
                Add new tag
              </button>

              {!tags ? (
                tagsError ? (
                  <div className="px-3 py-2 text-sm text-destructive">
                    {tagsError}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading tags...
                  </div>
                )
              ) : tags.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  No tags yet
                </div>
              ) : (
                <div className="space-y-1">
                  {tags.map((tag) => {
                    const isActive = activeTag === tag.name;

                    return (
                      <div
                        key={tag.id}
                        className={cn(
                          'group flex min-w-0 items-center gap-2 rounded-md px-2 py-1 transition-colors',
                          isActive
                            ? 'bg-accent text-accent-foreground'
                            : 'hover:bg-accent hover:text-accent-foreground text-muted-foreground'
                        )}
                      >
                        <button
                          onClick={() => selectTag(tag.name)}
                          className={cn(
                            'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                          )}
                        >
                          <span className="truncate">{tag.name}</span>
                          {tag.count !== undefined && (
                            <Badge variant="secondary" className="ml-auto shrink-0 h-5 px-1.5 text-xs">
                              {tag.count}
                            </Badge>
                          )}
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            asChild
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              className="flex shrink-0 h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={`Actions for ${tag.name}`}
                            >
                              <MoreVertical className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" side="right">
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                requestDeleteTag(tag.name, e);
                              }}
                              disabled={deletingTag === tag.name}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash className="mr-2 h-4 w-4" />
                              {deletingTag === tag.name ? "Deleting..." : "Delete Tag"}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </SidebarSection>

          <SidebarSection
            title="Saved Bundles"
            icon={<Folder className="h-4 w-4" />}
          >
            <div className="space-y-2">
              <Link
                href={'/bundles/new' as Route}
                className={cn(
                  'flex items-center px-3 py-2 text-sm rounded-md',
                  'border border-dashed border-muted-foreground/40 text-primary',
                  'transition-colors hover:bg-accent hover:text-accent-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                )}
              >
                + Add new bundle
              </Link>

              {!savedViews ? (
                <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading saved bundles...
                </div>
              ) : savedViews.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  No saved bundles
                </div>
              ) : (
                <div className="space-y-1">
                  {savedViews.map((view) => {
                    const href = `/bundles/${view.id}`;
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
            </div>
          </SidebarSection>
        </nav>
      </ScrollArea>
    </aside>
  );
}
