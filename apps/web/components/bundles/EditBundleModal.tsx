"use client";

import { useEffect, useState } from 'react';
import { FolderOpen, Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/Dialog';
import type { BundleListItem, BundleDetail } from '@vault/types';
import { BUNDLE_ICONS, DEFAULT_BUNDLE_COVER_ID } from '@/lib/bundleIcons';
import { emitBundlesUpdated } from '@/lib/bundles';

export interface EditBundleModalProps {
  bundle: BundleListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (updated: Partial<BundleListItem> & { id: string }) => void;
  onDeleted?: (id: string) => void;
}

export function EditBundleModal({ bundle, open, onOpenChange, onSaved, onDeleted }: EditBundleModalProps) {
  const [name, setName] = useState(bundle.name);
  const [description, setDescription] = useState(bundle.description ?? '');
  const [starred, setStarred] = useState(bundle.starred);
  const [coverMediaId, setCoverMediaId] = useState<string | null>(bundle.coverMediaId ?? null);
  const [items, setItems] = useState<BundleDetail['items']>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');

  const handleDelete = async () => {
    setIsDeleting(true);
    setError('');
    try {
      const res = await fetch(`/api/bundles/${bundle.id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) { setError('Failed to delete bundle.'); return; }
      emitBundlesUpdated();
      onDeleted?.(bundle.id);
      onOpenChange(false);
    } catch {
      setError('Failed to delete bundle.');
    } finally {
      setIsDeleting(false);
      setConfirmingDelete(false);
    }
  };

  useEffect(() => {
    if (open) {
      setConfirmingDelete(false);
      setName(bundle.name);
      setDescription(bundle.description ?? '');
      setStarred(bundle.starred);
      setCoverMediaId(bundle.coverMediaId ?? null);
      setError('');
      setLoadingItems(true);
      fetch(`/api/bundles/${bundle.id}`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then((d: { bundle: BundleDetail } | null) => {
          if (d?.bundle?.items) setItems(d.bundle.items);
        })
        .catch(() => {})
        .finally(() => setLoadingItems(false));
    }
  }, [open, bundle.id, bundle.name, bundle.description, bundle.starred, bundle.coverMediaId]);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError('Name is required.'); return; }
    setIsSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/bundles/${bundle.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, description: description.trim() || null, starred, coverMediaId }),
      });
      if (!res.ok) { setError('Failed to save. Please try again.'); return; }
      emitBundlesUpdated();
      onSaved({ id: bundle.id, name: trimmed, description: description.trim() || null, starred, coverMediaId });
      onOpenChange(false);
    } catch {
      setError('Failed to save. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg w-full">
        <DialogHeader>
          <DialogTitle>Edit Bundle</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setStarred(s => !s)}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <Star
              className={cn(
                'h-4 w-4 transition-colors',
                starred ? 'fill-yellow-400 text-yellow-400' : 'text-muted-foreground',
              )}
            />
            {starred ? 'Starred' : 'Star this bundle'}
          </button>
        </div>

        <div className="space-y-1 mt-4">
          <label className="text-sm font-medium" htmlFor="bundle-name">Name</label>
          <input
            id="bundle-name"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={200}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div className="space-y-1 mt-4">
          <label className="text-sm font-medium" htmlFor="bundle-description">Description</label>
          <textarea
            id="bundle-description"
            value={description}
            onChange={e => setDescription(e.target.value)}
            maxLength={1000}
            rows={3}
            placeholder="Optional description…"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
          />
        </div>

        <div className="mt-4 space-y-3">
          <p className="text-sm font-medium">Cover Image</p>

          {/* ── Row 1: default + icon options ── */}
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">Icons</p>
            <div className="flex flex-wrap gap-2">
              {/* No-cover / default */}
              <button
                type="button"
                onClick={() => setCoverMediaId(DEFAULT_BUNDLE_COVER_ID)}
                title="Default (no cover)"
                className={cn(
                  'h-10 w-10 rounded-md border-2 flex items-center justify-center bg-muted transition-colors',
                  coverMediaId === null || coverMediaId === DEFAULT_BUNDLE_COVER_ID
                    ? 'border-primary'
                    : 'border-transparent hover:border-muted-foreground/40',
                )}
              >
                <FolderOpen className="h-5 w-5 text-muted-foreground/60" />
              </button>

              {BUNDLE_ICONS.map(({ key, label, Icon }) => {
                const value = `icon:${key}`;
                const selected = coverMediaId === value;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setCoverMediaId(value)}
                    title={label}
                    className={cn(
                      'h-10 w-10 rounded-md border-2 flex items-center justify-center bg-muted transition-colors',
                      selected
                        ? 'border-primary'
                        : 'border-transparent hover:border-muted-foreground/40',
                    )}
                  >
                    <Icon className={cn('h-5 w-5', selected ? 'text-foreground' : 'text-muted-foreground/60')} />
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Row 2: media thumbnails ── */}
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">Media</p>
            {loadingItems ? (
              <div className="grid grid-cols-4 gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="aspect-square rounded-md bg-muted animate-pulse" />
                ))}
              </div>
            ) : items.filter(i => i.thumbState === 'READY').length === 0 ? (
              <p className="text-sm text-muted-foreground">No items with thumbnails yet.</p>
            ) : (
              <div className="grid grid-cols-4 gap-2 max-h-48 overflow-y-auto pr-1">
                {items.filter(i => i.thumbState === 'READY').map(item => (
                    <button
                      key={item.mediaId}
                      type="button"
                      onClick={() => setCoverMediaId(item.mediaId)}
                      className={cn(
                        'aspect-square rounded-md border-2 overflow-hidden transition-colors',
                        coverMediaId === item.mediaId
                          ? 'border-primary'
                          : 'border-transparent hover:border-muted-foreground/40',
                      )}
                      title={item.title}
                    >
                      <img
                        src={`/api/media/${item.mediaId}/thumbnail?v=ready`}
                        alt={item.title}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

        <DialogFooter className="flex-row items-center justify-between sm:justify-between">
          {/* Delete — left side */}
          <div className="flex items-center gap-2">
            {confirmingDelete ? (
              <>
                <button
                  type="button"
                  onClick={() => { void handleDelete(); }}
                  disabled={isDeleting}
                  className="inline-flex items-center justify-center rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50"
                >
                  {isDeleting ? 'Deleting…' : 'Confirm delete'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={isDeleting}
                  className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                disabled={isSaving}
                className="inline-flex items-center justify-center rounded-md border border-destructive px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
              >
                Delete bundle
              </button>
            )}
          </div>

          {/* Save / Cancel — right side */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={isDeleting}
              className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { void handleSave(); }}
              disabled={isSaving || isDeleting}
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {isSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
