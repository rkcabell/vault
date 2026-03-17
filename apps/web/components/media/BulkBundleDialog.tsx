// File: apps/web/components/media/BulkBundleDialog.tsx
"use client";

import { useEffect, useState } from 'react';
import { FolderOpen, Check } from 'lucide-react';
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

  useEffect(() => {
    if (!open) return;
    setChosenId(null);
    setError(null);
    setIsLoading(true);
    fetch('/api/bundles', { credentials: 'include' })
      .then(res => res.ok ? res.json() as Promise<{ bundles: BundleSummary[] }> : Promise.reject(new Error(`Error ${res.status}`)))
      .then(data => setBundles(data.bundles ?? []))
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load bundles'))
      .finally(() => setIsLoading(false));
  }, [open]);

  const handleAdd = async () => {
    if (!chosenId) return;
    setIsAdding(true);
    setError(null);
    try {
      const res = await fetch(`/api/bundles/${chosenId}/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mediaIds: selectedIds }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `Failed (${res.status})`);
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
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add to Bundle</DialogTitle>
          <DialogDescription>
            Select a bundle to add {selectedIds.length} item(s) to.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-60 overflow-y-auto space-y-1 rounded-md border p-1">
          {isLoading && (
            <p className="py-4 text-center text-sm text-muted-foreground">Loading bundles…</p>
          )}
          {!isLoading && bundles.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">No bundles yet.</p>
          )}
          {!isLoading && bundles.map(bundle => {
            const isChosen = chosenId === bundle.id;
            return (
              <button
                key={bundle.id}
                type="button"
                onClick={() => setChosenId(bundle.id)}
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
          <Button onClick={() => void handleAdd()} disabled={!chosenId || isAdding}>
            {isAdding ? 'Adding…' : `Add to Bundle`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
