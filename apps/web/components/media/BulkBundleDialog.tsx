// File: apps/web/components/media/BulkBundleDialog.tsx
"use client";

import { useEffect, useState } from 'react';
import { FolderOpen, FolderPlus, Check } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/Dialog';
import { emitBundlesUpdated } from '@/lib/bundles';
import { httpStatusMessage } from '@/lib/http';

interface BundleSummary {
  id: string;
  name: string;
  itemCount?: number;
}

interface BulkBundleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: string[];
  onDone: () => void;
}

export function BulkBundleDialog({ open, onOpenChange, selectedIds, onDone }: BulkBundleDialogProps) {
  const [bundles, setBundles] = useState<BundleSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newBundleName, setNewBundleName] = useState('');

  useEffect(() => {
    if (!open) return;
    setChosenId(null);
    setError(null);
    setIsCreating(false);
    setNewBundleName('');
    setIsLoading(true);
    fetch('/api/bundles', { credentials: 'include' })
      .then(res => res.ok ? res.json() as Promise<{ bundles: BundleSummary[] }> : Promise.reject(new Error(`Could not load bundles: ${httpStatusMessage(res.status)}`)))
      .then(data => setBundles(data.bundles ?? []))
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load bundles'))
      .finally(() => setIsLoading(false));
  }, [open]);

  const handleAdd = async () => {
    setIsAdding(true);
    setError(null);
    try {
      let targetId = chosenId;

      if (isCreating) {
        const trimmed = newBundleName.trim();
        if (!trimmed) return;
        const createRes = await fetch('/api/bundles', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ name: trimmed }),
        });
        const createData = await createRes.json().catch(() => ({})) as { bundle?: BundleSummary; error?: string };
        if (!createRes.ok) throw new Error(createData.error ?? `Could not create bundle: ${httpStatusMessage(createRes.status)}`);
        targetId = createData.bundle!.id;
      }

      if (!targetId) return;

      const res = await fetch(`/api/bundles/${targetId}/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mediaIds: selectedIds }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `Could not add to bundle: ${httpStatusMessage(res.status)}`);
      }
      emitBundlesUpdated();
      onDone();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsAdding(false);
    }
  };

  const handleClose = () => {
    if (isAdding) return;
    setChosenId(null);
    setError(null);
    setIsCreating(false);
    setNewBundleName('');
    onOpenChange(false);
  };

  const canSubmit = isCreating ? newBundleName.trim().length > 0 : chosenId !== null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add to Bundle</DialogTitle>
          <DialogDescription>
            Select a bundle or create a new one to add {selectedIds.length} item(s) to.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-60 overflow-y-auto space-y-1 rounded-md border p-1">
          {/* New bundle row */}
          {!isCreating ? (
            <button
              type="button"
              onClick={() => { setIsCreating(true); setChosenId(null); }}
              className="w-full flex items-center gap-3 rounded px-3 py-2 text-sm text-left transition-colors text-primary hover:bg-accent"
            >
              <FolderPlus className="h-4 w-4 shrink-0" />
              <span>New bundle…</span>
            </button>
          ) : (
            <div className="flex items-center gap-2 rounded bg-primary/10 px-3 py-2">
              <FolderPlus className="h-4 w-4 shrink-0 text-primary" />
              <input
                autoFocus
                type="text"
                value={newBundleName}
                onChange={e => setNewBundleName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && canSubmit && !isAdding) void handleAdd();
                  if (e.key === 'Escape') { setIsCreating(false); setNewBundleName(''); }
                }}
                placeholder="Bundle name…"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              <button
                type="button"
                onClick={() => { setIsCreating(false); setNewBundleName(''); }}
                className="text-xs text-muted-foreground hover:text-foreground"
                aria-label="Cancel new bundle"
              >
                ✕
              </button>
            </div>
          )}

          {bundles.length > 0 && <div className="border-t my-1" />}

          {isLoading && (
            <p className="py-4 text-center text-sm text-muted-foreground">Loading bundles…</p>
          )}
          {!isLoading && bundles.length === 0 && (
            <p className="py-2 text-center text-sm text-muted-foreground">No existing bundles.</p>
          )}
          {!isLoading && bundles.map(bundle => {
            const isChosen = chosenId === bundle.id;
            return (
              <button
                key={bundle.id}
                type="button"
                onClick={() => { setChosenId(bundle.id); setIsCreating(false); setNewBundleName(''); }}
                className={`w-full flex items-center gap-3 rounded px-3 py-2 text-sm text-left transition-colors
                  ${isChosen ? 'bg-primary/10 text-primary' : 'hover:bg-accent'}`}
              >
                <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{bundle.name}</span>
                {bundle.itemCount !== undefined && (
                  <span className="text-xs text-muted-foreground">{bundle.itemCount}</span>
                )}
                {isChosen && <Check className="h-4 w-4 shrink-0" />}
              </button>
            );
          })}
        </div>

        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isAdding}>
            Cancel
          </Button>
          <Button onClick={() => void handleAdd()} disabled={!canSubmit || isAdding}>
            {isAdding ? 'Adding…' : isCreating ? 'Create & Add' : 'Add to Bundle'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
