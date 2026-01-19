"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toaster";
import { PanelCard } from "@/components/common/PanelCard";
import { emitTagsUpdated, TAGS_UPDATED_EVENT } from "@/lib/tags";

type TagRow = { name: string; count: number };

const MAX_FETCH = 50;
const INITIAL_VISIBLE = 20;

function ManageTags() {
  const [tags, setTags] = useState<TagRow[]>([]);
  const [visible, setVisible] = useState(INITIAL_VISIBLE);
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tags?limit=${MAX_FETCH}`, { credentials: "include" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const msg = data?.message || data?.error || "Unable to load tags.";
        setError(msg);
        return;
      }
      const data = (await res.json()) as { tags?: TagRow[] };
      setTags(data.tags ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load tags.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const handler = () => void load();
    window.addEventListener(TAGS_UPDATED_EVENT, handler);
    return () => window.removeEventListener(TAGS_UPDATED_EVENT, handler);
  }, []);

  const visibleTags = useMemo(() => tags.slice(0, visible), [tags, visible]);
  const canShowMore = visible < Math.min(tags.length, MAX_FETCH);

  const handleDelete = async (name: string) => {
    if (isDeleting) return;
    const confirmed = window.confirm(`Delete tag "${name}"? This will remove it from all media.`);
    if (!confirmed) return;
    setIsDeleting(name);
    setError(null);
    try {
      const res = await fetch(`/api/tags/${encodeURIComponent(name)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const msg = data?.message || data?.error || "Unable to delete tag.";
        setError(msg);
        return;
      }
      setTags(prev => prev.filter(t => t.name !== name));
      emitTagsUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete tag.");
    } finally {
      setIsDeleting(null);
    }
  };

  return (
    <PanelCard title="Manage Tags" storageKey="settings.manageTags">
      <div className="space-y-3">
        {error && <div className="text-sm text-destructive">{error}</div>}
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading tags...</div>
        ) : visibleTags.length === 0 ? (
          <div className="text-sm text-muted-foreground">No tags yet.</div>
        ) : (
          <div className="space-y-2">
            {visibleTags.map(tag => (
              <div
                key={tag.name}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-3">
                  <span className="font-medium">{tag.name}</span>
                  <span className="text-xs text-muted-foreground">{tag.count} items</span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleDelete(tag.name)}
                  disabled={isDeleting === tag.name}
                >
                  {isDeleting === tag.name ? "Deleting..." : "Delete"}
                </Button>
              </div>
            ))}
            {canShowMore && (
              <Button variant="outline" size="sm" onClick={() => setVisible(v => v + 10)}>
                Show more
              </Button>
            )}
          </div>
        )}
      </div>
    </PanelCard>
  );
}

function PreferencesCard() {
  const [autoTagOnUpload, setAutoTagOnUpload] = useState(false);
  const [thumbnailSize, setThumbnailSize] = useState<"small" | "medium" | "large">("medium");
  const [extractMetadata, setExtractMetadata] = useState(true);
  const [detectDuplicates, setDetectDuplicates] = useState(false);
  const [collapseMetadataByDefault, setCollapseMetadataByDefault] = useState(true);
  const [themePreference, setThemePreference] = useState<"system" | "light" | "dark">("system");

  const handleDeleteEmptyTags = () => {
    toast("Are you sure? This will delete all tags with 0 linked files.");
    // TODO: call the backend to remove empty tags when the endpoint exists.
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>General Settings</CardTitle>
        <CardDescription>Configure uploads, tags, and metadata defaults.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <label htmlFor="auto-tag-on-upload" className="text-sm font-medium">
              Auto-tag files on upload
            </label>
            <p className="text-xs text-muted-foreground">Automatically apply tags to newly uploaded media.</p>
          </div>
          {/* TODO: persist auto-tag preference once settings storage is available. */}
          <input
            id="auto-tag-on-upload"
            type="checkbox"
            checked={autoTagOnUpload}
            onChange={event => setAutoTagOnUpload(event.target.checked)}
            className="h-5 w-5 rounded border border-border bg-card text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        </div>

        <div className="flex items-center justify-between gap-6">
          <div className="space-y-1">
            <label htmlFor="thumbnail-size" className="text-sm font-medium">
              Thumbnail size
            </label>
            <p className="text-xs text-muted-foreground">Small / Medium / Large</p>
          </div>
          {/* TODO: store thumbnail size preference for future uploads. */}
          <select
            id="thumbnail-size"
            value={thumbnailSize}
            onChange={event => setThumbnailSize(event.target.value as "small" | "medium" | "large")}
            className="h-9 rounded-md border border-border bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </div>

        <div className="flex items-center justify-between gap-6">
          <div className="space-y-1">
            <label htmlFor="extract-exif" className="text-sm font-medium">
              Extract photo camera metadata (EXIF)
            </label>
            <p className="text-xs text-muted-foreground">Keep camera metadata attached to uploads.</p>
          </div>
          {/* TODO: sync this toggle with the metadata preferences API. */}
          <input
            id="extract-exif"
            type="checkbox"
            checked={extractMetadata}
            onChange={event => setExtractMetadata(event.target.checked)}
            className="h-5 w-5 rounded border border-border bg-card text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        </div>

        <div className="flex items-center justify-between gap-6">
          <div className="space-y-1">
            <label htmlFor="detect-duplicates" className="text-sm font-medium">
              Detect exact duplicates
            </label>
            <p className="text-xs text-muted-foreground">Scan uploads using hash comparison.</p>
          </div>
          {/* TODO: implement hash-based duplicate detection. */}
          <input
            id="detect-duplicates"
            type="checkbox"
            checked={detectDuplicates}
            onChange={event => setDetectDuplicates(event.target.checked)}
            className="h-5 w-5 rounded border border-border bg-card text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        </div>

        <div className="flex flex-col gap-2 rounded-md border border-border px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Delete all empty tags</p>
              <p className="text-xs text-muted-foreground">Removes tags with zero linked files.</p>
            </div>
            <Button variant="destructive" size="sm" onClick={handleDeleteEmptyTags}>
              Delete all empty tags
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Use the button above to sweep tags that are no longer in use.
          </p>
        </div>

        <div className="flex items-center justify-between gap-6">
          <div className="space-y-1">
            <label htmlFor="collapse-metadata-default" className="text-sm font-medium">
              Collapse Metadata by default
            </label>
            <p className="text-xs text-muted-foreground">Close metadata panels when media details open.</p>
          </div>
          {/* TODO: respect this setting when rendering the metadata panel. */}
          <input
            id="collapse-metadata-default"
            type="checkbox"
            checked={collapseMetadataByDefault}
            onChange={event => setCollapseMetadataByDefault(event.target.checked)}
            className="h-5 w-5 rounded border border-border bg-card text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        </div>

        <div className="flex items-center justify-between gap-6">
          <div className="space-y-1">
            <label htmlFor="theme-preference" className="text-sm font-medium">
              Theme
            </label>
            <p className="text-xs text-muted-foreground">System / Light / Dark</p>
          </div>
          {/* TODO: apply the selected theme to the global layout. */}
          <select
            id="theme-preference"
            value={themePreference}
            onChange={event => setThemePreference(event.target.value as "system" | "light" | "dark")}
            className="h-9 rounded-md border border-border bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold mb-2">Settings</h1>
        <p className="text-muted-foreground">Configure your account and app preferences here.</p>
      </div>

      <PreferencesCard />
      <ManageTags />
    </div>
  );
}
