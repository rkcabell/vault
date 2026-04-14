"use client";

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { Folder, FolderOpen, Plus, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BundleListItem } from '@vault/types';
import { EditBundleModal } from '@/components/bundles/EditBundleModal';
import { AddMediaDialog } from '@/components/bundles/AddMediaDialog';
import { BundleCard } from '@/components/bundles/BundleCard';

export default function BundlesPage() {
  const [bundles, setBundles] = useState<BundleListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editingBundle, setEditingBundle] = useState<BundleListItem | null>(null);
  const [addingToBundle, setAddingToBundle] = useState<BundleListItem | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQ(searchInput.trim()), 300);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  }, [searchInput]);

  useEffect(() => {
    setIsLoading(true);
    const url = debouncedQ ? `/api/bundles?q=${encodeURIComponent(debouncedQ)}` : '/api/bundles';
    fetch(url, { credentials: 'include' })
      .then(r => r.ok ? r.json() : { bundles: [] })
      .then((d: { bundles: BundleListItem[] }) => setBundles(d.bundles ?? []))
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [debouncedQ]);

  const handleStarToggle = (id: string, starred: boolean) => {
    // Optimistically update the star state, then refetch for correct starredAt ordering.
    setBundles(prev => prev.map(b => b.id === id ? { ...b, starred } : b));
    const url = debouncedQ ? `/api/bundles?q=${encodeURIComponent(debouncedQ)}` : '/api/bundles';
    fetch(url, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((d: { bundles: BundleListItem[] } | null) => { if (d) setBundles(d.bundles ?? []); })
      .catch(() => {});
  };

  const handleEditSaved = (updated: Partial<BundleListItem> & { id: string }) => {
    setBundles(prev => prev.map(b => b.id === updated.id ? { ...b, ...updated } : b));
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
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              placeholder="Search bundles..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="h-9 w-48 rounded-md border border-input bg-background pl-8 pr-8 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
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
          {debouncedQ ? (
            <>
              <p className="text-lg font-medium">No bundles match &ldquo;{debouncedQ}&rdquo;</p>
              <p className="text-sm text-muted-foreground mt-1">Try a different search term</p>
            </>
          ) : (
            <>
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
            </>
          )}
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
          onDeleted={id => { setBundles(prev => prev.filter(b => b.id !== id)); setEditingBundle(null); }}
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
