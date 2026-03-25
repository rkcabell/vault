"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, BookOpen, File as FileIcon, FileText, Film, FolderOpen, Image as ImageIcon, Loader2, Music, Search, Video, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TagFilterChip, type TagFilterState } from '@/components/media/TagFilterChip';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { MediaWorkerState } from '@/lib/media/types';
import { getBundleIcon, DEFAULT_BUNDLE_ICON } from '@/lib/bundleIcons';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PickerItem {
  id: string;
  title: string;
  thumbState: MediaWorkerState;
  textState: MediaWorkerState;
  mimeType?: string | null;
}

type ActiveType = 'image' | 'video' | 'document' | null;

// ── Helpers ───────────────────────────────────────────────────────────────────

const TYPE_FILTERS: { label: string; value: ActiveType; icon: React.ReactNode; mimePrefix: string }[] = [
  { label: 'Images',    value: 'image',    icon: <ImageIcon className="h-3.5 w-3.5" />,    mimePrefix: 'image/' },
  { label: 'Videos',   value: 'video',    icon: <Video className="h-3.5 w-3.5" />,    mimePrefix: 'video/' },
  { label: 'Documents', value: 'document', icon: <FileText className="h-3.5 w-3.5" />, mimePrefix: 'application/pdf' },
];

function getPickerIcon(mimeType?: string | null) {
  if (!mimeType) return FileIcon;
  const m = mimeType.toLowerCase();
  if (m.startsWith('audio/')) return Music;
  if (m === 'application/epub+zip') return BookOpen;
  if (m.startsWith('video/')) return Film;
  if (m === 'application/zip' || m === 'application/x-zip-compressed' ||
      m === 'application/x-7z-compressed' || m === 'application/x-rar-compressed' ||
      m === 'application/vnd.rar') return Archive;
  if (m.startsWith('text/') || m === 'application/json' ||
      m.startsWith('application/vnd.oasis.opendocument') ||
      m === 'application/pdf') return FileText;
  return FileIcon;
}

function buildQS(q: string, tags: Set<string>, excludeTags: Set<string>, type: ActiveType, cursor: string | null) {
  const qs = new URLSearchParams({ limit: '30' });
  if (q.trim()) qs.set('q', q.trim());
  if (tags.size > 0) qs.set('tags', [...tags].join(','));
  if (excludeTags.size > 0) qs.set('excludeTags', [...excludeTags].join(','));
  if (type) qs.set('mimeType', TYPE_FILTERS.find(t => t.value === type)!.mimePrefix);
  if (cursor) qs.set('cursor', cursor);
  return qs.toString();
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface AddMediaDialogProps {
  open: boolean;
  onClose: () => void;
  bundleId: string;
  bundleName: string;
  coverMediaId?: string | null;
  /** Pass when already known (e.g. bundle detail page). If omitted, fetched from the API on open. */
  existingIds?: Set<string>;
  onAdded: (ids: string[]) => void;
}

export function AddMediaDialog({
  open,
  onClose,
  bundleId,
  bundleName,
  coverMediaId,
  existingIds: existingIdsProp,
  onAdded,
}: AddMediaDialogProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickerItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isAdding, setIsAdding] = useState(false);
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [excludeActiveTags, setExcludeActiveTags] = useState<Set<string>>(new Set());
  const [tagSearch, setTagSearch] = useState('');
  const [activeType, setActiveType] = useState<ActiveType>(null);
  const [fetchedExistingIds, setFetchedExistingIds] = useState<Set<string>>(new Set());
  const searchAbortRef = useRef<AbortController | null>(null);
  const loadingMoreRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const lastClickedIdxRef = useRef<number>(-1);

  const existingIds = existingIdsProp ?? fetchedExistingIds;

  const freshSearch = useCallback(async (q: string, tags: Set<string>, excludeTags: Set<string>, type: ActiveType) => {
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setIsSearching(true);
    setResults([]);
    setNextCursor(null);
    setHasMore(false);
    try {
      const res = await fetch(`/api/media?${buildQS(q, tags, excludeTags, type, null)}`, {
        credentials: 'include',
        signal: controller.signal,
      });
      if (!res.ok) return;
      const data = (await res.json()) as { items: PickerItem[]; nextCursor: string | null };
      if (searchAbortRef.current !== controller) return;
      setResults(data.items ?? []);
      setNextCursor(data.nextCursor ?? null);
      setHasMore(!!data.nextCursor);
    } catch {
      // aborted or error
    } finally {
      if (searchAbortRef.current === controller) setIsSearching(false);
    }
  }, []);

  const loadMore = useCallback(async (cursor: string, q: string, tags: Set<string>, excludeTags: Set<string>, type: ActiveType) => {
    if (loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      const res = await fetch(`/api/media?${buildQS(q, tags, excludeTags, type, cursor)}`, { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as { items: PickerItem[]; nextCursor: string | null };
      setResults(prev => [...prev, ...(data.items ?? [])]);
      setNextCursor(data.nextCursor ?? null);
      setHasMore(!!data.nextCursor);
    } catch {
      // error
    } finally {
      loadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, []);

  // Reset + initial load when dialog opens
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(new Set());
      setActiveTags(new Set());
      setExcludeActiveTags(new Set());
      setTagSearch('');
      setActiveType(null);
      void freshSearch('', new Set(), new Set(), null);
      fetch('/api/tags?limit=200', { credentials: 'include' })
        .then(r => r.ok ? r.json() : { tags: [] })
        .then((d: { tags: { name: string }[] }) => setTagOptions(d.tags?.map(t => t.name) ?? []))
        .catch(() => {});
      // Fetch existing IDs only when not provided by the parent
      if (!existingIdsProp) {
        fetch(`/api/bundles/${bundleId}`, { credentials: 'include' })
          .then(r => r.ok ? r.json() : null)
          .then((d: { bundle: { items: { mediaId: string }[] } } | null) => {
            setFetchedExistingIds(new Set(d?.bundle?.items?.map(i => i.mediaId) ?? []));
          })
          .catch(() => {});
      }
    }
    return () => searchAbortRef.current?.abort();
  }, [open, bundleId, existingIdsProp, freshSearch]);

  // Re-search on filter changes (debounced)
  useEffect(() => {
    const id = setTimeout(() => { void freshSearch(query, activeTags, excludeActiveTags, activeType); }, 300);
    return () => clearTimeout(id);
  }, [query, activeTags, excludeActiveTags, activeType, freshSearch]);

  // Infinite scroll sentinel
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting && hasMore && !loadingMoreRef.current && nextCursor) {
        void loadMore(nextCursor, query, activeTags, excludeActiveTags, activeType);
      }
    }, { threshold: 0.1 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, nextCursor, query, activeTags, excludeActiveTags, activeType, loadMore]);

  const getTagFilterState = (tag: string): TagFilterState => {
    if (activeTags.has(tag)) return 'include';
    if (excludeActiveTags.has(tag)) return 'exclude';
    return 'unselected';
  };

  const cycleTag = (tag: string) => {
    if (activeTags.has(tag)) {
      setActiveTags(prev => { const next = new Set(prev); next.delete(tag); return next; });
      setExcludeActiveTags(prev => { const next = new Set(prev); next.add(tag); return next; });
    } else if (excludeActiveTags.has(tag)) {
      setExcludeActiveTags(prev => { const next = new Set(prev); next.delete(tag); return next; });
    } else {
      setActiveTags(prev => { const next = new Set(prev); next.add(tag); return next; });
    }
  };

  const toggle = (id: string, idx: number, shiftKey: boolean) => {
    if (shiftKey && lastClickedIdxRef.current >= 0) {
      const lo = Math.min(lastClickedIdxRef.current, idx);
      const hi = Math.max(lastClickedIdxRef.current, idx);
      setSelected(prev => {
        const next = new Set(prev);
        for (let i = lo; i <= hi; i++) {
          const item = results[i];
          if (item && !existingIds.has(item.id)) next.add(item.id);
        }
        return next;
      });
    } else {
      setSelected(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
    }
    lastClickedIdxRef.current = idx;
  };

  const handleAdd = async () => {
    const ids = [...selected].filter(id => !existingIds.has(id));
    if (!ids.length) return;
    setIsAdding(true);
    try {
      const res = await fetch(`/api/bundles/${bundleId}/items`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaIds: ids }),
      });
      if (res.ok) { onAdded(ids); onClose(); }
    } finally {
      setIsAdding(false);
    }
  };

  const addable = [...selected].filter(id => !existingIds.has(id)).length;
  const iconCover = getBundleIcon(coverMediaId);
  const CoverIcon = iconCover ?? DEFAULT_BUNDLE_ICON;
  const filteredTags = tagSearch.trim()
    ? tagOptions.filter(t => t.toLowerCase().includes(tagSearch.toLowerCase()))
    : tagOptions;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <div
        style={{ width: '60vw', height: '80vh' }}
        className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 flex flex-col rounded-lg border bg-background shadow-lg overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-4 shrink-0">
          <div className="flex items-center gap-3">
            {coverMediaId && !iconCover ? (
              <img
                src={`/api/media/${coverMediaId}/thumbnail`}
                alt={bundleName}
                className="h-16 w-16 rounded object-cover shrink-0"
              />
            ) : (
              <CoverIcon className="h-5 w-5 text-primary shrink-0" />
            )}
            <div>
              <p className="text-xs text-muted-foreground leading-none mb-0.5">Adding media to</p>
              <h2 className="text-base font-semibold leading-none">{bundleName}</h2>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Filters */}
        <div className="px-4 py-3 border-b space-y-2 shrink-0">
          {/* Search + type buttons */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search media…"
                className="pl-9"
              />
            </div>
            <div className="flex items-center gap-1">
              {TYPE_FILTERS.map(f => (
                <button
                  key={f.value as string}
                  type="button"
                  onClick={() => setActiveType(prev => prev === f.value ? null : f.value)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                    activeType === f.value
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground',
                  )}
                >
                  {f.icon}{f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Tag search + pills */}
          {tagOptions.length > 0 && (
            <div className="space-y-1.5">
              {tagOptions.length > 8 && (
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
                  <input
                    value={tagSearch}
                    onChange={e => setTagSearch(e.target.value)}
                    placeholder="Filter tags…"
                    className="w-full rounded-md border border-input bg-background pl-7 pr-3 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {filteredTags.map(tag => (
                  <TagFilterChip
                    key={tag}
                    tag={tag}
                    state={getTagFilterState(tag)}
                    onCycle={cycleTag}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Results grid */}
        <div className="flex-1 overflow-y-auto p-4">
          {!isSearching && (
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-muted-foreground">
                {results.length === 0
                  ? 'No media found'
                  : `${results.length}${hasMore ? '+' : ''} item${results.length !== 1 ? 's' : ''}`}
              </p>
              {results.length > 0 && (
                <div className="flex items-center gap-2">
                  {selected.size > 0 && (
                    <span className="text-xs text-muted-foreground">{selected.size} selected</span>
                  )}
                  <button
                    type="button"
                    onClick={() => setSelected(new Set(results.filter(r => !existingIds.has(r.id)).map(r => r.id)))}
                    className="text-xs text-primary hover:underline"
                  >
                    Select all
                  </button>
                  {selected.size > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelected(new Set())}
                      className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {isSearching ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : results.length === 0 ? null : (
            <>
              <div className="grid grid-cols-5 gap-2">
                {results.map((item, idx) => {
                  const alreadyIn = existingIds.has(item.id);
                  const isSelected = selected.has(item.id);
                  const thumbReady = item.thumbState === 'READY';
                  const PickerIcon = getPickerIcon(item.mimeType);
                  return (
                    <button
                      key={item.id}
                      onMouseDown={e => { if (e.shiftKey) e.preventDefault(); }}
                      onClick={e => { if (!alreadyIn) toggle(item.id, idx, e.shiftKey); }}
                      disabled={alreadyIn}
                      className={cn(
                        'relative rounded-lg overflow-hidden border-2 text-left transition-all',
                        alreadyIn
                          ? 'opacity-40 cursor-not-allowed border-transparent'
                          : isSelected
                          ? 'border-primary'
                          : 'border-transparent hover:border-muted-foreground/40',
                      )}
                    >
                      <div className="aspect-[4/3] bg-muted flex items-center justify-center">
                        {thumbReady ? (
                          <img
                            src={`/api/media/${item.id}/thumbnail?v=ready`}
                            alt={item.title}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <PickerIcon className="h-8 w-8 text-muted-foreground" />
                        )}
                      </div>
                      <div className="px-1.5 py-1">
                        <p className="text-xs truncate">{item.title}</p>
                      </div>
                      {isSelected && !alreadyIn && (
                        <div className="absolute top-1.5 right-1.5 h-5 w-5 rounded-full bg-primary flex items-center justify-center">
                          <span className="text-[10px] font-bold text-primary-foreground">✓</span>
                        </div>
                      )}
                      {alreadyIn && (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className="text-xs font-medium bg-background/80 px-2 py-0.5 rounded">Added</span>
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Infinite scroll sentinel */}
              <div ref={sentinelRef} className="h-8 flex items-center justify-center mt-2">
                {isLoadingMore && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t px-4 py-3 shrink-0">
          <Button
            className="w-full"
            onClick={() => { void handleAdd(); }}
            disabled={addable === 0 || isAdding}
          >
            {isAdding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {addable > 0 ? `Add ${addable} item${addable > 1 ? 's' : ''}` : 'Select items to add'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
