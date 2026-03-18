// File: apps/web/components/media/BulkTagDialog.tsx
"use client";

import { useState, useRef, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/Dialog';
import { normalizeTags, TagValidationError, emitTagsUpdated } from '@/lib/tags';
import type { MediaItem } from './MediaCard';

interface BulkTagDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedItems: MediaItem[];
  onDone: (updatedItems: MediaItem[]) => void;
}

export function BulkTagDialog({ open, onOpenChange, selectedItems, onDone }: BulkTagDialogProps) {
  const [tagInput, setTagInput] = useState('');
  const [pendingTags, setPendingTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const commitInput = () => {
    const raw = tagInput.trim();
    if (!raw) return;
    try {
      const normalized = normalizeTags(raw);
      setPendingTags(prev => {
        const merged = [...prev, ...normalized];
        // deduplicate
        return [...new Set(merged)];
      });
      setTagInput('');
      setError(null);
    } catch (err) {
      if (err instanceof TagValidationError) setError(err.message);
    }
  };

  const removeTag = (tag: string) => {
    setPendingTags(prev => prev.filter(t => t !== tag));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitInput();
    }
  };

  const handleSave = async () => {
    commitInput();
    // Give React a tick to flush the pending tag from commitInput above
    await new Promise(r => setTimeout(r, 0));

    const tags = pendingTags.length > 0 ? pendingTags : normalizeTags(tagInput.trim() || []);
    if (tags.length === 0) {
      setError('Enter at least one tag.');
      return;
    }

    setIsSaving(true);
    setError(null);
    const updatedItems: MediaItem[] = [];

    for (let i = 0; i < selectedItems.length; i++) {
      const item = selectedItems[i];
      setProgress(`Saving ${i + 1} of ${selectedItems.length}…`);
      try {
        const merged = normalizeTags([...(item.tags ?? []), ...tags]);
        const res = await fetch(`/api/media/${item.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ tags: merged }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(data.error ?? `Failed for "${item.title}"`);
        }
        updatedItems.push({ ...item, tags: merged });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
        setIsSaving(false);
        setProgress(null);
        return;
      }
    }

    setIsSaving(false);
    setProgress(null);
    setPendingTags([]);
    setTagInput('');
    emitTagsUpdated();
    onDone(updatedItems);
    onOpenChange(false);
  };

  const handleClose = () => {
    if (isSaving) return;
    setPendingTags([]);
    setTagInput('');
    setError(null);
    setProgress(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Tags</DialogTitle>
          <DialogDescription>
            Tags will be merged with existing tags on {selectedItems.length} item(s).
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-1.5 mb-2 min-h-[2rem]">
          {pendingTags.map(tag => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
            >
              {tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                className="ml-0.5 rounded-full hover:bg-primary/20 p-0.5"
                aria-label={`Remove tag ${tag}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>

        <Input
          ref={inputRef}
          value={tagInput}
          onChange={e => setTagInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commitInput}
          placeholder="e.g. work, important (Enter or comma to add)"
          disabled={isSaving}
          className="mb-1"
        />
        <p className="text-xs text-muted-foreground mb-2">
          Lowercase letters, digits, and dashes only. Press Enter or comma to add a tag.
        </p>

        {error && <p className="text-sm text-destructive mb-2">{error}</p>}
        {progress && <p className="text-sm text-muted-foreground mb-2">{progress}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={isSaving || (pendingTags.length === 0 && !tagInput.trim())}>
            {isSaving ? 'Saving…' : 'Apply Tags'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
