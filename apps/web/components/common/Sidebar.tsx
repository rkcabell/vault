//File: apps/web/components/common/Sidebar.tsx

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { useSplitDrag } from '@/hooks/useSplitDrag';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown, ChevronRight, Tag, Folder, Loader2, Search, X, MoreVertical, Pencil, Trash, Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/ui/Badge';
import type { Route } from "next";
import { emitTagsUpdated, partitionTagsByOrigin } from '@/lib/tags';
import type { TagOrigin } from '@vault/types';
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
  origin?: TagOrigin;
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
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  contentClassName?: string;
}

function SidebarSection({
  title,
  icon,
  children,
  defaultOpen = true,
  isOpen: controlledOpen,
  onOpenChange,
  className,
  contentClassName,
}: SidebarSectionProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const toggle = () => {
    if (onOpenChange) onOpenChange(!isOpen);
    else setInternalOpen(o => !o);
  };

  return (
    <div className={cn('mb-4', className)}>
      <button
        onClick={toggle}
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
      {isOpen && <div className={cn('mt-1', contentClassName)}>{children}</div>}
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
  const [tagsOpen, setTagsOpen] = useState(true);
  const [tagSearch, setTagSearch] = useState('');
  const { ratio: tagsSplitRatio, isDragging: isDraggingSplit, containerRef: splitContainerRef, onPointerDown: startSplitDrag, onKeyDown: splitKeyDown } = useSplitDrag({
    storageKey: 'vault.sidebar.tagsSplitRatio.v2',
    defaultRatio: 0.40,
    min: 0.25,
    max: 0.8,
  });

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
      const res = await apiFetch(`/api/tags/${encodeURIComponent(tag)}`, {
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
      const res = await apiFetch(`/api/tags/${encodeURIComponent(renamingTag)}`, {
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
      const res = await apiFetch('/api/bundles', { credentials: 'include', signal: controller.signal });
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
      const res = await apiFetch(`/api/tags?limit=${PAGE_SIZE}&offset=${offset}`, { credentials: 'include' });
      if (!res.ok) { hasMoreRef.current = false; setHasMoreTags(false); return; }
      const data = await res.json() as { tags: Array<{ name: string; count: number; color: string | null; origin?: TagOrigin }> };
      const newTags = data.tags.map(t => ({ id: t.name, name: t.name, count: t.count, color: t.color, origin: t.origin }));
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
  // Re-runs when the sentinel mounts/unmounts (hasMoreTags) and after the first
  // tags arrive (displayedTags.length) — the sentinel doesn't exist on first
  // mount (tags seed asynchronously), so without these deps it was never observed.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      entries => { if (entries[0]?.isIntersecting) void fetchMoreTags(); },
      { root: tagsScrollRef.current, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchMoreTags, hasMoreTags, displayedTags.length]);

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
      <div className="h-full px-3 py-4">
        <nav className="h-full min-h-0">
          <div ref={splitContainerRef} className="flex h-full min-h-0 flex-col">
            <div
              className={cn('overflow-hidden', tagsOpen ? 'min-h-0' : 'shrink-0')}
              style={tagsOpen ? { flexBasis: `${tagsSplitRatio * 100}%` } : undefined}
            >
              <SidebarSection
                title="Tags"
                icon={<Tag className="h-4 w-4" suppressHydrationWarning />}
                className="mb-0 flex h-full min-h-0 flex-col"
                contentClassName="mt-1 flex min-h-0 flex-1 flex-col"
                isOpen={tagsOpen}
                onOpenChange={setTagsOpen}
              >
                <div className="flex min-h-0 flex-1 flex-col space-y-2 min-w-0">
              <div className="relative w-full min-w-0">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search tags…"
                  value={tagSearch}
                  onChange={e => setTagSearch(e.target.value)}
                  className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-7 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
                {tagSearch && (
                  <button
                    type="button"
                    onClick={() => setTagSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label="Clear tag search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

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
              ) : displayedTags.filter(t => !optimisticallyDeletedTags.has(t.name) && (!tagSearch || t.name.toLowerCase().includes(tagSearch.toLowerCase()))).length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  No matching tags
                </div>
              ) : (
                <div
                  ref={tagsScrollRef}
                  className="vault-scrollbar min-h-0 flex-1 overflow-y-auto space-y-1 pr-0.5"
                >
                  {partitionTagsByOrigin(
                    displayedTags.filter(t =>
                      !optimisticallyDeletedTags.has(t.name) &&
                      (!tagSearch || t.name.toLowerCase().includes(tagSearch.toLowerCase()))
                    ),
                    t => t.origin === 'AUTO',
                  ).map((tag) => {
                    const isRenaming = renamingTag === tag.name;
                    const selected = isTagSelected(tag.name);
                    const isAuto = tag.origin === 'AUTO';
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
                            <span className={cn('truncate pr-px', isAuto && !selected && 'italic opacity-70')}>{tag.name}</span>
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
            </div>

          <div
            role="separator"
            aria-label="Resize tags and bundles"
            aria-orientation="horizontal"
            tabIndex={tagsOpen ? 0 : -1}
            onPointerDown={tagsOpen ? startSplitDrag : undefined}
            onKeyDown={tagsOpen ? splitKeyDown : undefined}
            className={cn(
              'group relative my-1 flex shrink-0 items-center py-2',
              tagsOpen ? 'cursor-row-resize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm' : 'cursor-default'
            )}
          >
            <div className={cn(
              'h-px w-full rounded-full bg-border/50 transition-colors',
              tagsOpen && 'group-hover:bg-border',
              isDraggingSplit && 'bg-primary/40'
            )} />
          </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              <SidebarSection
                title="Bundles"
                icon={<Folder className="h-4 w-4" />}
                className="mb-0 flex h-full min-h-0 flex-col"
                contentClassName="mt-1 flex min-h-0 flex-1 flex-col"
              >
                <div className="flex min-h-0 flex-1 flex-col space-y-2">
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
                <div className="vault-scrollbar min-h-0 flex-1 overflow-y-auto space-y-1 pr-0.5">
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
            </div>
          </div>
        </nav>
      </div>
    </aside>
  );
}
