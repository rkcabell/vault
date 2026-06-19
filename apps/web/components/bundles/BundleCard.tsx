"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import Link from "next/link";
import type { Route } from "next";
import { Pencil, Plus, Star } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { cn } from "@/lib/utils";
import { getBundleIcon, DEFAULT_BUNDLE_ICON } from "@/lib/bundleIcons";
import { emitBundlesUpdated } from "@/lib/bundles";
import type { BundleListItem } from "@vault/types";

interface BundleCardProps {
  bundle: BundleListItem;
  onStarToggle: (id: string, next: boolean) => void;
  onEdit: (bundle: BundleListItem) => void;
  onAddMedia: (bundle: BundleListItem) => void;
}

export function BundleCard({ bundle, onStarToggle, onEdit, onAddMedia }: BundleCardProps) {
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
      const res = await apiFetch(`/api/bundles/${bundle.id}/star`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        const data = (await res.json()) as { starred: boolean };
        onStarToggle(bundle.id, data.starred);
        emitBundlesUpdated();
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
              className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-115"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center transition-transform duration-300 ease-out group-hover:scale-115">
              <FallbackIcon className="h-12 w-12 text-muted-foreground/40" />
            </div>
          )}

          {/* Star — top-left overlay */}
          <button
            onClick={(e) => { void handleStar(e); }}
            disabled={isStarring}
            aria-label={bundle.starred ? "Unstar bundle" : "Star bundle"}
            className="absolute top-2 left-2 z-10 p-2 text-muted-foreground hover:text-yellow-500 transition-all disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Star className={cn("h-5 w-5", bundle.starred && "fill-yellow-400 text-yellow-400")} />
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
              {bundle.itemCount} {bundle.itemCount === 1 ? "item" : "items"}
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
