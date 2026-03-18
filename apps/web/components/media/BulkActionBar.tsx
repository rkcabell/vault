// File: apps/web/components/media/BulkActionBar.tsx
"use client";

import React from 'react';
import { Button } from '@/components/ui/Button';
import { Trash2, Tag, FolderPlus } from 'lucide-react';

interface BulkActionBarProps {
  count: number;
  onDelete: (e: React.MouseEvent) => void;
  onTag: () => void;
  onAddToBundle: () => void;
  onClear: () => void;
}

export function BulkActionBar({ count, onDelete, onTag, onAddToBundle, onClear }: BulkActionBarProps) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t bg-background shadow-lg">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-6 py-3">
        <span className="text-sm font-medium">{count} selected</span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onTag}>
            <Tag className="mr-2 h-4 w-4" />
            Tag
          </Button>
          <Button size="sm" variant="outline" onClick={onAddToBundle}>
            <FolderPlus className="mr-2 h-4 w-4" />
            Add to Bundle
          </Button>
          <Button size="sm" variant="destructive" onClick={(e) => onDelete(e)}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear}>
            Clear
          </Button>
        </div>
      </div>
    </div>
  );
}
