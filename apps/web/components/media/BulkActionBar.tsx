// File: apps/web/components/media/BulkActionBar.tsx
"use client";

import { useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { Trash2, Tag, FolderPlus, Download } from 'lucide-react';

interface BulkActionBarProps {
  count: number;
  onDelete: (info: { centerX: number; anchorWidth: number; bottomOffset: number }) => void;
  onTag: () => void;
  onAddToBundle: () => void;
  onClear: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onSelectAll: () => void;
  isDownloading?: boolean;
}

export function BulkActionBar({ count, onDelete, onTag, onAddToBundle, onClear, onDownload, onCancel, onSelectAll, isDownloading }: BulkActionBarProps) {
  const deleteRef = useRef<HTMLButtonElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const hasSelection = count > 0;

  const handleDeleteClick = () => {
    if (deleteRef.current && barRef.current) {
      const btnRect = deleteRef.current.getBoundingClientRect();
      const barRect = barRef.current.getBoundingClientRect();
      onDelete({
        centerX: btnRect.left + btnRect.width / 2,
        anchorWidth: btnRect.width,
        bottomOffset: window.innerHeight - barRect.top + 8,
      });
    }
  };

  return (
    <div ref={barRef} className="fixed bottom-0 left-0 right-0 z-40 border-t bg-background shadow-lg">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-6 py-3">
        {/* Mode controls: Cancel, count, Select All, Clear */}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          {hasSelection && (
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <span className="inline-flex items-center justify-center rounded-full bg-primary px-2.5 py-0.5 text-sm font-bold text-primary-foreground">
                {count}
              </span>
              <span className="!text-foreground">Selected</span>
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={onSelectAll}>
            Select All
          </Button>
          {hasSelection && (
            <Button size="sm" variant="ghost" onClick={onClear}>
              Clear Selection
            </Button>
          )}
        </div>
        {/* File actions: Tag, Bundle, Download, Delete */}
        {hasSelection && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={onTag}>
              <Tag className="mr-2 h-4 w-4" />
              Tag
            </Button>
            <Button size="sm" variant="outline" onClick={onAddToBundle}>
              <FolderPlus className="mr-2 h-4 w-4" />
              Add to Bundle
            </Button>
            <Button size="sm" variant="outline" onClick={onDownload} disabled={isDownloading}>
              <Download className="mr-2 h-4 w-4" />
              {isDownloading ? "Zipping…" : "Download"}
            </Button>
            <Button ref={deleteRef} size="sm" variant="destructive" onClick={handleDeleteClick}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
