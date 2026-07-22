// File: apps/web/components/media/BulkActionBar.tsx
"use client";

import { useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { Trash2, Tag, FolderPlus, Download, RefreshCw, FileText } from 'lucide-react';

interface BulkActionBarProps {
  /** Effective selection size (library-wide total when isSelectAllLibrary). */
  count: number;
  /** Items currently loaded in the view (the "select all" button's scope). */
  visibleCount: number;
  /** Full library count under the current filter; null while unknown. */
  totalCount: number | null;
  /** True when the whole library (not just loaded items) is selected. */
  isSelectAllLibrary: boolean;
  onSelectAllLibraryChange: (next: boolean) => void;
  /** Anchor info for the delete confirm popover, which opens BELOW the bar. */
  onDelete: (info: { centerX: number; anchorWidth: number; topOffset: number }) => void;
  onTag: () => void;
  onAddToBundle: () => void;
  onClear: () => void;
  onDownload: () => void;
  onRegenerateThumbnail: () => void;
  onExtractText: () => void;
  onCancel: () => void;
  onSelectAll: () => void;
  isDownloading?: boolean;
  isRequeueing?: boolean;
}

/**
 * Selection toolbar shown in select mode. Sticky at the top of the scroll
 * container (in normal flow — no bottom-bar overlay, no padding hacks) so the
 * actions stay reachable while scrolling a long grid. All select-all controls
 * live here: select visible → escalate to whole library → clear.
 */
export function BulkActionBar({
  count,
  visibleCount,
  totalCount,
  isSelectAllLibrary,
  onSelectAllLibraryChange,
  onDelete,
  onTag,
  onAddToBundle,
  onClear,
  onDownload,
  onRegenerateThumbnail,
  onExtractText,
  onCancel,
  onSelectAll,
  isDownloading,
  isRequeueing,
}: BulkActionBarProps) {
  const deleteRef = useRef<HTMLButtonElement>(null);
  const hasSelection = count > 0;
  const allVisibleSelected = visibleCount > 0 && count >= visibleCount;
  const canEscalateToLibrary =
    !isSelectAllLibrary && allVisibleSelected && totalCount !== null && totalCount > visibleCount;

  const handleDeleteClick = () => {
    if (!deleteRef.current) return;
    const btnRect = deleteRef.current.getBoundingClientRect();
    onDelete({
      centerX: btnRect.left + btnRect.width / 2,
      anchorWidth: btnRect.width,
      topOffset: btnRect.bottom + 8,
    });
  };

  return (
    <div className="sticky top-2 z-40 mb-4 rounded-xl border bg-background/95 shadow-md backdrop-blur supports-[backdrop-filter]:bg-background/85">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-4 py-2.5">
        {/* Mode + selection controls */}
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        {hasSelection && (
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <span className="inline-flex items-center justify-center rounded-full bg-primary px-2.5 py-0.5 text-sm font-bold text-primary-foreground">
              {count}
            </span>
            <span className="!text-foreground">
              {isSelectAllLibrary ? "in library selected" : "selected"}
            </span>
          </span>
        )}
        {!isSelectAllLibrary && !allVisibleSelected && (
          <Button size="sm" variant="ghost" onClick={onSelectAll}>
            Select all
          </Button>
        )}
        {canEscalateToLibrary && (
          <button
            type="button"
            className="text-sm font-medium text-primary underline-offset-2 hover:underline"
            onClick={() => onSelectAllLibraryChange(true)}
          >
            Select all {totalCount} in library
          </button>
        )}
        {isSelectAllLibrary && (
          <button
            type="button"
            className="text-sm font-medium text-primary underline-offset-2 hover:underline"
            onClick={() => onSelectAllLibraryChange(false)}
          >
            Only loaded items
          </button>
        )}
        {hasSelection && (
          <Button size="sm" variant="ghost" onClick={onClear}>
            Clear
          </Button>
        )}

        {/* File actions */}
        {hasSelection && (
          <div className="ml-auto flex flex-wrap gap-2">
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
            <Button
              size="sm"
              variant="outline"
              onClick={onRegenerateThumbnail}
              disabled={isRequeueing}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Regenerate thumbnail
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onExtractText}
              disabled={isRequeueing}
            >
              <FileText className="mr-2 h-4 w-4" />
              Extract text
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
