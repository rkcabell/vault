//File: apps/web/components/common/Sidebar.tsx

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown, ChevronRight, Tag, BookmarkCheck, Loader2, Plus, MoreVertical, Trash } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/ui/ScrollArea';
import { Badge } from '@/ui/Badge';
import type { Route } from "next";
import { Input } from '@/components/ui/Input';
import { emitTagsUpdated } from '@/lib/tags';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/DropdownMenu';

export interface TagItem {
  id: string;
  name: string;
  count?: number;
}

export interface SavedView {
  id: string;
  name: string;
  count?: number;
}

interface SidebarProps {
  tags?: TagItem[] | null;
  savedViews?: SavedView[] | null;
  tagsError?: string | null;
  isLoading?: boolean;
  className?: string;
}

interface SidebarSectionProps {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function SidebarSection({ title, icon, children, defaultOpen = true }: SidebarSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="mb-4">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'flex w-full items-center justify-between px-3 py-2 text-sm font-semibold',
          'rounded-md hover:bg-accent transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2">
          {icon}
          <span>{title}</span>
        </div>
        {isOpen ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
      </button>
      {isOpen && <div className="mt-1">{children}</div>}
    </div>
  );
}

export function Sidebar({ tags, savedViews, tagsError, isLoading = false, className }: SidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [isSavingTag, setIsSavingTag] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);
  const [deletingTag, setDeletingTag] = useState<string | null>(null);

  const activeTags = useMemo(() => {
    const tagsParam = searchParams.get("tags") || "";
    const tagParam = searchParams.get("tag") || "";
    const fromTags = tagsParam
      .split(",")
      .map(t => t.trim())
      .filter(Boolean);
    if (fromTags.length > 0) return fromTags;
    return tagParam ? [tagParam.trim()] : [];
  }, [searchParams]);

  const toggleTag = (tag: string) => {
    const params = new URLSearchParams(searchParams.toString());
    const selected = new Set(activeTags);
    if (selected.has(tag)) selected.delete(tag);
    else selected.add(tag);

    params.delete("tag");
    if (selected.size > 0) params.set("tags", Array.from(selected).join(","));
    else params.delete("tags");

    const targetPath = pathname.startsWith("/library") ? pathname : "/library";
    const qs = params.toString();
    router.push((qs ? `${targetPath}?${qs}` : targetPath)as Route);
  };

  const handleDeleteTag = async (tag: string) => {
    if (deletingTag) return;
    setDeletingTag(tag);
    setTagError(null);
    try {
      const res = await fetch(`/api/tags/${encodeURIComponent(tag)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const msg = data?.message || data?.error || "Unable to delete tag.";
        setTagError(msg);
        return;
      }
      emitTagsUpdated();
    } catch (err) {
      setTagError(err instanceof Error ? err.message : "Unable to delete tag.");
    } finally {
      setDeletingTag(null);
    }
  };

  const handleAddTag = async () => {
    const name = newTagName.trim();
    if (!name || isSavingTag) return;
    setIsSavingTag(true);
    setTagError(null);
    try {
      const res = await fetch("/api/tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const msg = data?.message || data?.error || "Unable to add tag.";
        setTagError(msg);
        return;
      }
      setNewTagName("");
      setIsAddingTag(false);
      emitTagsUpdated();
    } catch (err) {
      setTagError(err instanceof Error ? err.message : "Unable to add tag.");
    } finally {
      setIsSavingTag(false);
    }
  };

  if (isLoading) {
    return (
      <aside className={cn('w-64 border-r bg-background', className)}>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </aside>
    );
  }

  return (
    <aside className={cn('w-64 border-r bg-background', className)}>
      <ScrollArea className="h-full py-4">
        <nav className="px-3 space-y-1">
          <SidebarSection
            title="Tags"
            icon={<Tag className="h-4 w-4" />}
          >
            <div className="space-y-2">
              <Link
                href={'/tags/new' as Route}
                className={cn(
                  'hidden items-center px-3 py-2 text-sm rounded-md',
                  'border border-dashed border-muted-foreground/40 text-primary',
                  'transition-colors hover:bg-accent hover:text-accent-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                )}
              >
                + Add new tag
              </Link>
              <button
                type="button"
                onClick={() => setIsAddingTag((v) => !v)}
                className={cn(
                  'flex w-full items-center justify-between rounded-md border border-dashed border-muted-foreground/40 px-3 py-2 text-sm text-primary',
                  'transition-colors hover:bg-accent hover:text-accent-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                )}
              >
                <span className="flex items-center gap-2">
                  <Plus className="h-4 w-4" />
                  Add new tag
                </span>
                {isAddingTag ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>

              {isAddingTag && (
                <div className="space-y-2 rounded-md border border-dashed border-muted-foreground/30 bg-muted/30 px-3 py-2">
                  <Input
                    value={newTagName}
                    onChange={(e) => setNewTagName(e.target.value)}
                    placeholder="Tag name"
                    className="text-sm"
                    disabled={isSavingTag}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleAddTag();
                      }
                    }}
                  />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <button
                      type="button"
                      onClick={() => void handleAddTag()}
                      className={cn(
                        "rounded px-2 py-1",
                        isSavingTag
                          ? "bg-muted text-foreground"
                          : "bg-primary text-primary-foreground hover:bg-primary/90"
                      )}
                      disabled={isSavingTag}
                    >
                      {isSavingTag ? "Saving..." : "Add"}
                    </button>
                  </div>
                  {tagError && <div className="text-xs text-destructive">{tagError}</div>}
                </div>
              )}

              {!tags ? (
                tagsError ? (
                  <div className="px-3 py-2 text-sm text-destructive">
                    {tagsError}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading tags...
                  </div>
                )
              ) : tags.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  No tags yet
                </div>
              ) : (
                <div className="space-y-1">
                  {tags.map((tag) => {
                    const isActive = activeTags.includes(tag.name);

                    return (
                      <div
                        key={tag.id}
                        className={cn(
                          'group flex items-center gap-2 rounded-md px-2 py-1 transition-colors',
                          isActive
                            ? 'bg-accent text-accent-foreground'
                            : 'hover:bg-accent hover:text-accent-foreground text-muted-foreground'
                        )}
                      >
                        <button
                          onClick={() => toggleTag(tag.name)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                          )}
                        >
                          <span className="truncate">{tag.name}</span>
                          {tag.count !== undefined && (
                            <Badge variant="secondary" className="ml-auto h-5 px-1.5 text-xs">
                              {tag.count}
                            </Badge>
                          )}
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            asChild
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={`Actions for ${tag.name}`}
                            >
                              <MoreVertical className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" side="right">
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleDeleteTag(tag.name);
                              }}
                              disabled={deletingTag === tag.name}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash className="mr-2 h-4 w-4" />
                              {deletingTag === tag.name ? "Deleting..." : "Delete Tag"}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </SidebarSection>

          <SidebarSection
            title="Saved Albums"
            icon={<BookmarkCheck className="h-4 w-4" />}
          >
            <div className="space-y-2">
              <Link
                href={'/albums/new' as Route}
                className={cn(
                  'flex items-center px-3 py-2 text-sm rounded-md',
                  'border border-dashed border-muted-foreground/40 text-primary',
                  'transition-colors hover:bg-accent hover:text-accent-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                )}
              >
                + Add new album
              </Link>

              {!savedViews ? (
                <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading saved albums...
                </div>
              ) : savedViews.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  No saved albums
                </div>
              ) : (
                <div className="space-y-1">
                  {savedViews.map((view) => {
                    const href = `/views/${view.id}`;
                    const isActive = pathname === href;

                    return (
                      <Link
                        key={view.id}
                        href={href as Route}
                        className={cn(
                          'flex items-center justify-between px-3 py-2 text-sm rounded-md',
                          'transition-colors hover:bg-accent hover:text-accent-foreground',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          isActive
                            ? 'bg-accent text-accent-foreground font-medium'
                            : 'text-muted-foreground'
                        )}
                      >
                        <span className="truncate">{view.name}</span>
                        {view.count !== undefined && (
                          <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-xs">
                            {view.count}
                          </Badge>
                        )}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </SidebarSection>
        </nav>
      </ScrollArea>
    </aside>
  );
}
