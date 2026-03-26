"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Route } from 'next';
import { ArrowLeft, ChevronDown, FolderOpen, MoreHorizontal, Pencil, Plus, Star, Trash2, Upload } from 'lucide-react';
import { EditBundleModal } from '@/components/bundles/EditBundleModal';
import { AddMediaDialog } from '@/components/bundles/AddMediaDialog';
import { cn } from '@/lib/utils';
import { emitBundlesUpdated } from '@/lib/bundles';
import { emitTagsUpdated } from '@/lib/tags';
import type { BundleDetail, BundleMediaItem } from '@vault/types';
import { MediaCard } from '@/components/media/MediaCard';
import { TagFilterChip, type TagFilterState } from '@/components/media/TagFilterChip';
import { Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Skeleton } from '@/components/ui/Skeleton';
import { ConfirmPopover } from '@/components/ui/ConfirmPopover';
import type { MediaWorkerState } from '@/lib/media/types';

// ── Sort options ──────────────────────────────────────────────────────────────

const SORT_OPTIONS = [
  { value: "addedAt_desc",   label: "Newest" },
  { value: "addedAt_asc",    label: "Oldest" },
  { value: "title_asc",      label: "Name A-Z" },
  { value: "title_desc",     label: "Name Z-A" },
  { value: "size_desc",      label: "Largest" },
  { value: "size_asc",       label: "Smallest" },
  { value: "mimeType_asc",   label: "Type" },
] as const;

type SortValue = (typeof SORT_OPTIONS)[number]["value"];
const DEFAULT_SORT: SortValue = "addedAt_desc";

function sortItems(items: BundleDetail["items"], sort: SortValue): BundleDetail["items"] {
  const sorted = [...items];
  switch (sort) {
    case "addedAt_desc":  return sorted.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    case "addedAt_asc":   return sorted.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
    case "title_asc":     return sorted.sort((a, b) => a.title.localeCompare(b.title));
    case "title_desc":    return sorted.sort((a, b) => b.title.localeCompare(a.title));
    case "size_desc":     return sorted.sort((a, b) => b.sizeBytes - a.sizeBytes);
    case "size_asc":      return sorted.sort((a, b) => a.sizeBytes - b.sizeBytes);
    case "mimeType_asc":  return sorted.sort((a, b) => a.mimeType.localeCompare(b.mimeType));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toMediaItem(item: BundleMediaItem) {
  return {
    id: item.mediaId,
    title: item.title,
    thumbState: item.thumbState as MediaWorkerState,
    textState: item.textState as MediaWorkerState,
    mimeType: item.mimeType,
  };
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text || `Error ${res.status}`;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BundleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [bundle, setBundle] = useState<BundleDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [removingId, setRemovingId] = useState<string | null>(null);
  const [isDeletingBundle, setIsDeletingBundle] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [confirmState, setConfirmState] = useState<{ x: number; y: number } | null>(null);
  const [exportConfirmState, setExportConfirmState] = useState<{ x: number; y: number } | null>(null);
  const [isStarring, setIsStarring] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [sort, setSort] = useState<SortValue>(DEFAULT_SORT);
  const [tagFilter, setTagFilter] = useState<Record<string, TagFilterState>>({});

  const allTags = useMemo(() => {
    const set = new Set<string>();
    bundle?.items.forEach(item => item.tags?.forEach(t => set.add(t)));
    return Array.from(set).sort();
  }, [bundle]);

  const cycleTag = (tag: string) => {
    setTagFilter(prev => {
      const cur = prev[tag] ?? 'unselected';
      const next: TagFilterState = cur === 'unselected' ? 'include' : cur === 'include' ? 'exclude' : 'unselected';
      const updated = { ...prev, [tag]: next };
      if (next === 'unselected') delete updated[tag];
      return updated;
    });
  };

  const includedTags = Object.entries(tagFilter).filter(([, s]) => s === 'include').map(([t]) => t);
  const excludedTags = Object.entries(tagFilter).filter(([, s]) => s === 'exclude').map(([t]) => t);

  const fetchBundle = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/bundles/${id}`, { credentials: 'include' });
      if (!res.ok) {
        if (res.status === 404) { router.replace('/bundles' as Route); return; }
        setError(await readError(res));
        return;
      }
      const data = (await res.json()) as { bundle: BundleDetail };
      setBundle(data.bundle);
    } catch {
      setError('Failed to load bundle.');
    } finally {
      setIsLoading(false);
    }
  }, [id, router]);

  useEffect(() => { void fetchBundle(); }, [fetchBundle]);

  const removeItem = async (mediaId: string) => {
    if (removingId) return;
    setRemovingId(mediaId);
    try {
      await fetch(`/api/bundles/${id}/items/${mediaId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      setBundle(prev =>
        prev ? { ...prev, items: prev.items.filter(i => i.mediaId !== mediaId), itemCount: prev.itemCount - 1 } : prev
      );
      emitBundlesUpdated();
    } finally {
      setRemovingId(null);
    }
  };

  const handleAdded = (mediaIds: string[]) => {
    void fetchBundle();
    setBundle(prev => prev ? { ...prev, itemCount: prev.itemCount + mediaIds.length } : prev);
  };

  const toggleStar = async () => {
    if (isStarring || !bundle) return;
    setIsStarring(true);
    try {
      const res = await fetch(`/api/bundles/${id}/star`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) {
        const data = (await res.json()) as { starred: boolean };
        setBundle(prev => prev ? { ...prev, starred: data.starred } : prev);
        emitBundlesUpdated();
      }
    } finally {
      setIsStarring(false);
    }
  };

  const handleExportZip = async () => {
    if (isExporting || !bundle) return;
    setIsExporting(true);
    try {
      const res = await fetch(`/api/bundles/${id}/export`, { credentials: 'include' });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${bundle.name}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setIsExporting(false);
    }
  };

  const deleteBundle = async () => {
    setIsDeletingBundle(true);
    try {
      await fetch(`/api/bundles/${id}`, { method: 'DELETE', credentials: 'include' });
      emitBundlesUpdated();
      emitTagsUpdated();
      router.push('/bundles' as Route);
    } finally {
      setIsDeletingBundle(false);
    }
  };

  if (isLoading) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <Skeleton className="h-8 w-48 mb-6" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[4/3] rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <p className="text-destructive">{error}</p>
        <Button variant="outline" className="mt-4" onClick={() => { void fetchBundle(); }}>
          Retry
        </Button>
      </div>
    );
  }

  if (!bundle) return null;

  const existingIds = new Set(bundle.items.map(i => i.mediaId));

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <Link
          href={'/bundles' as Route}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          All Bundles
        </Link>

        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">{bundle.name}</h1>
              <button
                onClick={() => { void toggleStar(); }}
                disabled={isStarring}
                aria-label={bundle.starred ? 'Unstar bundle' : 'Star bundle'}
                className="shrink-0 h-8 w-8 flex items-center justify-center text-muted-foreground hover:text-yellow-500 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
              >
                <Star
                  className={cn(
                    'h-5 w-5',
                    bundle.starred && 'fill-yellow-400 text-yellow-400',
                  )}
                />
              </button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowEditModal(true)}
                aria-label="Edit bundle"
                className="h-8 w-8 text-muted-foreground hover:text-foreground shrink-0"
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Bundle options" className="h-8 w-8 text-muted-foreground shrink-0">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    onClick={(e) => {
                      if (bundle && bundle.itemCount === 0) {
                        setExportConfirmState({ x: e.clientX, y: e.clientY });
                      } else {
                        void handleExportZip();
                      }
                    }}
                    disabled={isExporting}
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    {isExporting ? 'Exporting…' : 'Export as ZIP'}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) => { setConfirmState({ x: e.clientX, y: e.clientY }); }}
                    disabled={isDeletingBundle}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {isDeletingBundle ? 'Deleting…' : 'Delete Bundle'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {bundle.itemCount} {bundle.itemCount === 1 ? 'item' : 'items'}
              {bundle.description && ` · ${bundle.description}`}
            </p>
            {bundle.sourceMediaId && (
              <Link
                href={`/media/${bundle.sourceMediaId}` as Route}
                className="mt-1 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Source archive →
              </Link>
            )}
          </div>

          <div className="shrink-0">
            <Button onClick={() => setShowPicker(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add media
            </Button>
          </div>
        </div>
      </div>

      {/* Sort + tag filter toolbar */}
      {bundle.items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-4 rounded-lg border border-border bg-muted/30 px-3 py-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="flex items-center gap-2">
                <span>{SORT_OPTIONS.find(o => o.value === sort)?.label ?? "Custom order"}</span>
                <ChevronDown className="h-4 w-4 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[12rem]">
              {SORT_OPTIONS.map(option => (
                <DropdownMenuItem
                  key={option.value}
                  onClick={() => setSort(option.value)}
                  className={option.value === sort ? "font-semibold" : "text-muted-foreground"}
                >
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {allTags.length > 0 && (
            <>
              <div className="h-4 w-px shrink-0 bg-border" />
              {allTags.map(tag => (
                <TagFilterChip
                  key={tag}
                  tag={tag}
                  state={tagFilter[tag] ?? 'unselected'}
                  onCycle={cycleTag}
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* Items grid */}
      {bundle.items.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-muted-foreground/30 py-20 text-center">
          <FolderOpen className="h-10 w-10 text-muted-foreground/40 mb-3" />
          <p className="text-lg font-medium">No items yet</p>
          <p className="text-sm text-muted-foreground mt-1 mb-4">
            Add media to this bundle to get started
          </p>
          <Button onClick={() => setShowPicker(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add media
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {sortItems(bundle.items, sort)
            .filter(item => {
              if (includedTags.length > 0 && !includedTags.every(t => item.tags?.includes(t))) return false;
              if (excludedTags.some(t => item.tags?.includes(t))) return false;
              return true;
            })
            .map(item => (
              <div key={item.mediaId} className="relative group">
                <MediaCard
                  media={toMediaItem(item)}
                  variant="grid"
                  onDelete={() => removeItem(item.mediaId)}
                  isDeleting={removingId === item.mediaId}
                />
              </div>
            ))}
        </div>
      )}

      <AddMediaDialog
        open={showPicker}
        onClose={() => setShowPicker(false)}
        bundleId={id}
        bundleName={bundle.name}
        coverMediaId={bundle.coverMediaId}
        existingIds={existingIds}
        onAdded={handleAdded}
      />

      {showEditModal && (
        <EditBundleModal
          bundle={bundle}
          open={showEditModal}
          onOpenChange={open => { if (!open) setShowEditModal(false); }}
          onSaved={updated => {
            setBundle(prev => prev ? { ...prev, ...updated } : prev);
            setShowEditModal(false);
          }}
          onDeleted={() => router.push('/bundles' as Route)}
        />
      )}

      <ConfirmPopover
        open={confirmState !== null}
        x={confirmState?.x ?? 0}
        y={confirmState?.y ?? 0}
        message="Delete this bundle? This cannot be undone."
        onConfirm={() => { setConfirmState(null); void deleteBundle(); }}
        onCancel={() => setConfirmState(null)}
      />

      <ConfirmPopover
        open={exportConfirmState !== null}
        x={exportConfirmState?.x ?? 0}
        y={exportConfirmState?.y ?? 0}
        message="This bundle is empty. Are you sure you want to export it?"
        confirmLabel="Yes"
        cancelLabel="Nevermind"
        confirmVariant="default"
        onConfirm={() => { setExportConfirmState(null); void handleExportZip(); }}
        onCancel={() => setExportConfirmState(null)}
      />
    </div>
  );
}
