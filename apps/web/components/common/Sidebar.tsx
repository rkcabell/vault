//File: apps/web/components/common/Sidebar.tsx

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown, ChevronRight, Tag, Folder, Loader2, Plus, MoreVertical, Pencil, Trash, Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/ui/ScrollArea';
import { Badge } from '@/ui/Badge';
import type { Route } from "next";
import { emitTagsUpdated } from '@/lib/tags';
import { BUNDLES_UPDATED_EVENT } from '@/lib/bundles';
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
  color?: string | null;
}

interface BundleNavItem {
  id: string;
  name: string;
  count?: number;
  starred?: boolean;
}

interface SidebarProps {
  tags?: TagItem[] | null;
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

const PAGE_SIZE = 30;

export function Sidebar({ tags, tagsError, isLoading = false, className }: SidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{ x: number; y: number; tag: string; count: number } | null>(null);
  const [optimisticallyDeletedTags, setOptimisticallyDeletedTags] = useState<Set<string>>(new Set());
  // Rename state
  const [renamingTag, setRenamingTag] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [isRenamingSaving, setIsRenamingSaving] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Infinite scroll state
  const [displayedTags, setDisplayedTags] = useState<TagItem[]>([]);
  const [hasMoreTags, setHasMoreTags] = useState(false);
  const [isFetchingMoreTags, setIsFetchingMoreTags] = useState(false);
  const tagOffsetRef = useRef(0);
  const hasMoreRef = useRef(false);
  const fetchingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const tagsScrollRef = useRef<HTMLDivElement>(null);
  // Bundles self-managed state
  const [displayedBundles, setDisplayedBundles] = useState<BundleNavItem[]>([]);
  const bundlesAbortRef = useRef<AbortController | null>(null);
  const [isFetchingBundles, setIsFetchingBundles] = useState(false);

  const includedTags = useMemo(() => {
    const tagsParam = searchParams.get('tags') ?? '';
    const tagParam = searchParams.get('tag') ?? '';
    return new Set([
      ...tagsParam.split(',').map(t => t.trim()).filter(Boolean),
      ...tagParam.split(',').map(t => t.trim()).filter(Boolean),
    ]);
  }, [searchParams]);

  const isTagSelected = (tagName: string) => includedTags.has(tagName);

  const cycleTag = (tagName: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('tag');
    params.delete('excludeTags');
    if (includedTags.has(tagName)) {
      params.delete('tags');
    } else {
      params.set('tags', tagName);
    }
    const targetPath = pathname.startsWith('/library') ? pathname : '/library';
    const qs = params.toString();
    router.push((qs ? `${targetPath}?${qs}` : targetPath) as Route);
  };

  const requestDeleteTag = (tag: TagItem, e: React.MouseEvent) => {
    if (deletingTag) return;
    setConfirmState({ x: e.clientX, y: e.clientY, tag: tag.name, count: tag.count ?? 0 });
  };

  const handleDeleteTag = async (tag: string) => {
    setDeletingTag(tag);
    setOptimisticallyDeletedTags(prev => new Set([...prev, tag]));
    try {
      const res = await fetch(`/api/tags/${encodeURIComponent(tag)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        setOptimisticallyDeletedTags(prev => { const next = new Set(prev); next.delete(tag); return next; });
        return;
      }
      emitTagsUpdated({ deletedTag: tag });
      if (includedTags.has(tag)) {
        const params = new URLSearchParams(searchParams.toString());
        params.delete('tag');
        params.delete('tags');
        params.delete('excludeTags');
        const targetPath = pathname.startsWith('/library') ? pathname : '/library';
        const qs = params.toString();
        router.push((qs ? `${targetPath}?${qs}` : targetPath) as Route);
      }
    } finally {
      setDeletingTag(null);
    }
  };

  const startRename = (tag: TagItem) => {
    setRenamingTag(tag.name);
    setRenameValue(tag.name);
  };

  const cancelRename = () => {
    setRenamingTag(null);
    setRenameValue('');
  };

  const commitRename = async () => {
    if (!renamingTag) return;
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === renamingTag) { cancelRename(); return; }
    setIsRenamingSaving(true);
    try {
      const res = await fetch(`/api/tags/${encodeURIComponent(renamingTag)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) { cancelRename(); return; }
      emitTagsUpdated();
      cancelRename();
    } finally {
      setIsRenamingSaving(false);
    }
  };

  useEffect(() => {
    if (renamingTag) renameInputRef.current?.focus();
  }, [renamingTag]);

  const fetchBundles = useCallback(async () => {
    bundlesAbortRef.current?.abort();
    const controller = new AbortController();
    bundlesAbortRef.current = controller;
    setIsFetchingBundles(true);
    try {
      const res = await fetch('/api/bundles', { credentials: 'include', signal: controller.signal });
      if (!res.ok || bundlesAbortRef.current !== controller) return;
      const data = await res.json() as { bundles?: { id: string; name: string; itemCount: number; starred: boolean }[] };
      if (!data.bundles || bundlesAbortRef.current !== controller) return;
      setDisplayedBundles(data.bundles.map(b => ({ id: b.id, name: b.name, count: b.itemCount, starred: b.starred })));
    } catch { /* aborted or network error — keep current state */ }
    finally { if (bundlesAbortRef.current === controller) setIsFetchingBundles(false); }
  }, []);

  useEffect(() => {
    void fetchBundles();
  }, [fetchBundles]);

  useEffect(() => {
    const handler = () => { void fetchBundles(); };
    window.addEventListener(BUNDLES_UPDATED_EVENT, handler);
    return () => {
      window.removeEventListener(BUNDLES_UPDATED_EVENT, handler);
      bundlesAbortRef.current?.abort();
    };
  }, [fetchBundles]);

  // Seed displayedTags from the prop (set by AppShell via /api/init or tag refresh).
  useEffect(() => {
    if (tags === null || tags === undefined) {
      setDisplayedTags([]);
      tagOffsetRef.current = 0;
      hasMoreRef.current = false;
      setHasMoreTags(false);
      return;
    }
    setDisplayedTags(tags);
    tagOffsetRef.current = tags.length;
    const more = tags.length >= PAGE_SIZE;
    hasMoreRef.current = more;
    setHasMoreTags(more);
  }, [tags]);

  const fetchMoreTags = useCallback(async () => {
    if (fetchingRef.current || !hasMoreRef.current) return;
    fetchingRef.current = true;
    setIsFetchingMoreTags(true);
    try {
      const offset = tagOffsetRef.current;
      const res = await fetch(`/api/tags?limit=${PAGE_SIZE}&offset=${offset}`, { credentials: 'include' });
      if (!res.ok) { hasMoreRef.current = false; setHasMoreTags(false); return; }
      const data = await res.json() as { tags: Array<{ name: string; count: number; color: string | null }> };
      const newTags = data.tags.map(t => ({ id: t.name, name: t.name, count: t.count, color: t.color }));
      tagOffsetRef.current += newTags.length;
      const more = newTags.length === PAGE_SIZE;
      hasMoreRef.current = more;
      setDisplayedTags(prev => [...prev, ...newTags]);
      setHasMoreTags(more);
    } finally {
      fetchingRef.current = false;
      setIsFetchingMoreTags(false);
    }
  }, []); // stable — all mutable state accessed via refs

  // IntersectionObserver: fire when sentinel scrolls into the tags container.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      entries => { if (entries[0]?.isIntersecting) void fetchMoreTags(); },
      { root: tagsScrollRef.current, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchMoreTags]);

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
        message={`Delete tag "${confirmState?.tag}"? This will remove it from ${confirmState?.count ?? 0} item${(confirmState?.count ?? 0) === 1 ? '' : 's'}. This cannot be undone.`}
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
              ) : displayedTags.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  No tags yet
                </div>
              ) : (
                <div
                  ref={tagsScrollRef}
                  className="max-h-64 overflow-y-auto space-y-1 pr-0.5"
                >
                  {displayedTags.filter(t => !optimisticallyDeletedTags.has(t.name)).map((tag) => {
                    const isRenaming = renamingTag === tag.name;
                    const selected = isTagSelected(tag.name);
                    return (
                      <div
                        key={tag.id}
                        className={cn(
                          'group flex min-w-0 items-center gap-1 rounded-md transition-colors',
                          selected ? 'bg-primary/10' : 'hover:bg-accent',
                        )}
                      >
                        {/* Name button or rename input */}
                        {isRenaming ? (
                          <input
                            ref={renameInputRef}
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') { e.preventDefault(); void commitRename(); }
                              if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                            }}
                            onBlur={() => void commitRename()}
                            disabled={isRenamingSaving}
                            className="flex-1 min-w-0 rounded border border-ring bg-background px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring ml-2"
                          />
                        ) : (
                          <button
                            onClick={() => cycleTag(tag.name)}
                            title={selected ? `Clear filter "${tag.name}"` : `Filter by "${tag.name}"`}
                            className={cn(
                              'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              selected ? 'text-primary font-medium' : 'text-muted-foreground hover:text-accent-foreground',
                            )}
                          >
                            {!selected && tag.color && (
                              <span className="shrink-0 h-2 w-2 rounded-full" style={{ background: tag.color }} />
                            )}
                            <span className="truncate">{tag.name}</span>
                            {tag.count !== undefined && (
                              <Badge variant="secondary" className="ml-auto shrink-0 h-5 px-1.5 text-xs">
                                {tag.count}
                              </Badge>
                            )}
                          </button>
                        )}

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild onClick={e => e.stopPropagation()}>
                            <button
                              className="flex shrink-0 h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={`Actions for ${tag.name}`}
                            >
                              <MoreVertical className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" side="right">
                            <DropdownMenuItem
                              onClick={e => { e.stopPropagation(); startRename(tag); }}
                              disabled={!!deletingTag}
                            >
                              <Pencil className="mr-2 h-4 w-4" />
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={e => { e.stopPropagation(); requestDeleteTag(tag, e); }}
                              disabled={deletingTag === tag.name}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash className="mr-2 h-4 w-4" />
                              {deletingTag === tag.name ? 'Deleting…' : 'Delete Tag'}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                  })}
                  {hasMoreTags && <div ref={sentinelRef} />}
                  {isFetchingMoreTags && (
                    <div className="flex justify-center py-1">
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                    </div>
                  )}
                </div>
              )}
            </div>
          </SidebarSection>

          <SidebarSection
            title="Bundles"
            icon={<Folder className="h-4 w-4" />}
          >
            <div className="space-y-2">
              <Link
                href={'/bundles/new' as Route}
                className={cn(
                  'flex items-center px-3 py-2 text-sm rounded-md',
                  'border border-dashed border-muted-foreground/40 text-muted-foreground',
                  'transition-colors hover:bg-accent hover:text-accent-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                )}
              >
                + Add new bundle
              </Link>

              {isFetchingBundles && displayedBundles.length === 0 ? (
                <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading bundles...
                </div>
              ) : displayedBundles.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  No bundles yet
                </div>
              ) : (
                <div className="space-y-1">
                  {displayedBundles.map((view) => {
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
                        <span className="flex min-w-0 items-center gap-1.5">
                          {view.starred && (
                            <Star className="shrink-0 h-3 w-3" style={{ fill: "var(--color-star, #fbbf24)", color: "var(--color-star, #fbbf24)" }} />
                          )}
                          <span className="truncate">{view.name}</span>
                        </span>
                        {view.count !== undefined && (
                          <Badge variant="secondary" className="ml-2 shrink-0 h-5 px-1.5 text-xs">
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
