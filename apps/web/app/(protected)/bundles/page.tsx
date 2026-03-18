"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { Folder, FolderOpen, Pencil, Plus, Star } from 'lucide-react';
import { getBundleIcon, DEFAULT_BUNDLE_ICON } from '@/lib/bundleIcons';
import { Card, CardContent } from '@/components/ui/Card';
import { cn } from '@/lib/utils';
import type { BundleListItem } from '@vault/types';
import { EditBundleModal } from '@/components/bundles/EditBundleModal';
import { AddMediaDialog } from '@/components/bundles/AddMediaDialog';
// ─── Bundle Card ──────────────────────────────────────────────────────────────

function BundleCard({
  bundle,
  onStarToggle,
  onEdit,
  onAddMedia,
}: {
  bundle: BundleListItem;
  onStarToggle: (id: string, next: boolean) => void;
  onEdit: (bundle: BundleListItem) => void;
  onAddMedia: (bundle: BundleListItem) => void;
}) {
  const [isStarring, setIsStarring] = useState(false);
  const iconCover = getBundleIcon(bundle.coverMediaId);
  const coverSrc = !iconCover && bundle.coverMediaId
    ? `/api/media/${bundle.coverMediaId}/thumbnail?v=ready`
    : null;
  const FallbackIcon = iconCover ?? DEFAULT_BUNDLE_ICON;

  const handleStar = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isStarring) return;
    setIsStarring(true);
    try {
      const res = await fetch(`/api/bundles/${bundle.id}/star`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) {
        const data = (await res.json()) as { starred: boolean };
        onStarToggle(bundle.id, data.starred);
      }
    } finally {
      setIsStarring(false);
    }
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onEdit(bundle);
  };

  const handleAddMedia = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onAddMedia(bundle);
  };

  return (
    <Link href={`/bundles/${bundle.id}` as Route} className="group block">
      <Card className="overflow-hidden hover:shadow-lg transition-shadow h-full">
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
          {coverSrc ? (
            <img
              src={coverSrc}
              alt={bundle.name}
              className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-105"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <FallbackIcon className="h-12 w-12 text-muted-foreground/40" />
            </div>
          )}

          {/* Star — top-left overlay */}
          <button
            onClick={(e) => { void handleStar(e); }}
            disabled={isStarring}
            aria-label={bundle.starred ? 'Unstar bundle' : 'Star bundle'}
            className="absolute top-2 left-2 z-10 p-2 text-muted-foreground hover:text-yellow-500 transition-all disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Star className={cn('h-5 w-5', bundle.starred && 'fill-yellow-400 text-yellow-400')} />
          </button>
        </div>

        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold truncate">{bundle.name}</h3>
            <button
              onClick={handleEdit}
              title="Edit"
              aria-label="Edit bundle"
              className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
          {bundle.description && (
            <p className="mt-1 text-sm text-muted-foreground line-clamp-2">{bundle.description}</p>
          )}
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {bundle.itemCount} {bundle.itemCount === 1 ? 'item' : 'items'}
            </p>
            <button
              onClick={handleAddMedia}
              title="Add media"
              aria-label="Add media to bundle"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

// ─── Bundles Page ─────────────────────────────────────────────────────────────

export default function BundlesPage() {
  const [bundles, setBundles] = useState<BundleListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editingBundle, setEditingBundle] = useState<BundleListItem | null>(null);
  const [addingToBundle, setAddingToBundle] = useState<BundleListItem | null>(null);

  useEffect(() => {
    fetch('/api/bundles', { credentials: 'include' })
      .then(r => r.ok ? r.json() : { bundles: [] })
      .then((d: { bundles: BundleListItem[] }) => setBundles(d.bundles ?? []))
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  const handleStarToggle = (id: string, starred: boolean) => {
    setBundles(prev => {
      const updated = prev.map(b => b.id === id ? { ...b, starred } : b);
      return [...updated.filter(b => b.starred), ...updated.filter(b => !b.starred)];
    });
  };

  const handleEditSaved = (updated: Partial<BundleListItem> & { id: string }) => {
    setBundles(prev => {
      const next = prev.map(b => b.id === updated.id ? { ...b, ...updated } : b);
      return [...next.filter(b => b.starred), ...next.filter(b => !b.starred)];
    });
  };

  const handleMediaAdded = (ids: string[]) => {
    if (!addingToBundle) return;
    setBundles(prev => prev.map(b => b.id === addingToBundle.id ? { ...b, itemCount: b.itemCount + ids.length } : b));
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Folder className="h-6 w-6 text-muted-foreground" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Bundles</h1>
            <p className="text-sm text-muted-foreground">Organize your media into collections</p>
          </div>
        </div>
        <Link
          href={'/bundles/new' as Route}
          className={cn(
            'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors',
            'h-10 px-4 py-2 bg-primary text-primary-foreground hover:bg-primary/90',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          )}
        >
          <Plus className="h-4 w-4" />
          New Bundle
        </Link>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl bg-muted animate-pulse aspect-[4/3]" />
          ))}
        </div>
      ) : bundles.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-muted-foreground/30 py-20 text-center">
          <FolderOpen className="h-10 w-10 text-muted-foreground/40 mb-3" />
          <p className="text-lg font-medium">No bundles yet</p>
          <p className="text-sm text-muted-foreground mt-1 mb-4">
            Create a bundle to group related media together
          </p>
          <Link
            href={'/bundles/new' as Route}
            className={cn(
              'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors',
              'h-10 px-4 py-2 border border-input bg-background hover:bg-accent hover:text-accent-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            )}
          >
            <Plus className="h-4 w-4" />
            Create your first bundle
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {bundles.map(bundle => (
            <BundleCard
              key={bundle.id}
              bundle={bundle}
              onStarToggle={handleStarToggle}
              onEdit={setEditingBundle}
              onAddMedia={setAddingToBundle}
            />
          ))}
        </div>
      )}

      {editingBundle && (
        <EditBundleModal
          bundle={editingBundle}
          open={editingBundle !== null}
          onOpenChange={open => { if (!open) setEditingBundle(null); }}
          onSaved={handleEditSaved}
        />
      )}

      {addingToBundle && (
        <AddMediaDialog
          open
          onClose={() => setAddingToBundle(null)}
          bundleId={addingToBundle.id}
          bundleName={addingToBundle.name}
          coverMediaId={addingToBundle.coverMediaId}
          onAdded={handleMediaAdded}
        />
      )}
    </div>
  );
}
