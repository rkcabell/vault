"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, File as FileIcon, Film, Loader2, Music, Search, X } from "lucide-react";
import { Input } from "@/components/ui/Input";

export type MediaPickerItem = {
  id: string;
  title: string | null;
  filename: string;
  thumbState?: "PENDING" | "READY" | "ERROR" | "FAILED";
  mimeType?: string | null;
};

type MediaPickerProps = {
  value: MediaPickerItem | null;
  onChange: (item: MediaPickerItem | null) => void;
  disabled?: boolean;
};

function getDisplayLabel(item: MediaPickerItem) {
  return item.title ?? item.filename;
}

function getMimeIcon(mimeType?: string | null) {
  if (!mimeType) return FileIcon;
  const m = mimeType.toLowerCase();
  if (m.startsWith("audio/")) return Music;
  if (m.startsWith("video/")) return Film;
  if (m.startsWith("text/") || m.includes("pdf") || m.includes("document")) return FileText;
  return FileIcon;
}

export function MediaPicker({ value, onChange, disabled }: MediaPickerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MediaPickerItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const search = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: "20" });
        if (q.trim()) params.set("query", q.trim());
        const res = await fetch(`/api/media?${params.toString()}`, {
          credentials: "include",
          signal: controller.signal,
        });
        if (!res.ok || abortRef.current !== controller) return;
        const data = (await res.json()) as { items: MediaPickerItem[] };
        setResults(data.items ?? []);
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
      } finally {
        if (abortRef.current === controller) setLoading(false);
      }
    }, 300);
  }, []);

  // Load initial results when picker opens
  useEffect(() => {
    if (open) search(query);
    return () => { abortRef.current?.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleQueryChange = (q: string) => {
    setQuery(q);
    search(q);
  };

  const handleSelect = (item: MediaPickerItem) => {
    onChange(item);
    setOpen(false);
    setQuery("");
  };

  const handleClear = () => {
    onChange(null);
    setQuery("");
    setResults([]);
    setOpen(false);
  };

  // — Selected state: show a compact card —
  if (value) {
    const thumbReady = value.thumbState === "READY";
    const MimeIcon = getMimeIcon(value.mimeType);
    return (
      <div className="flex items-center gap-3 rounded-md border border-input bg-background px-3 py-2">
        <div className="h-9 w-9 shrink-0 rounded overflow-hidden bg-muted flex items-center justify-center">
          {thumbReady ? (
            <img
              src={`/api/media/${value.id}/thumbnail?v=ready`}
              alt={getDisplayLabel(value)}
              className="h-full w-full object-cover"
            />
          ) : (
            <MimeIcon className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <span className="flex-1 text-sm truncate">{getDisplayLabel(value)}</span>
        {!disabled && (
          <button
            type="button"
            onClick={handleClear}
            aria-label="Remove linked item"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  }

  // — Empty state: search input + inline results —
  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          value={query}
          onChange={e => handleQueryChange(e.target.value)}
          onFocus={() => { if (!open) setOpen(true); }}
          onBlur={() => setOpen(false)}
          placeholder="Search items..."
          disabled={disabled}
          className="pl-9"
          autoComplete="off"
          aria-label="Search for a linked media item"
        />
      </div>

      {open && (
        <div className="rounded-md border border-input bg-background overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : results.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No items found</p>
          ) : (
            <ul className="overflow-y-auto vault-scrollbar divide-y divide-border" style={{ maxHeight: "20rem" }}>
              {results.map(item => {
                const thumbReady = item.thumbState === "READY";
                const MimeIcon = getMimeIcon(item.mimeType);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onPointerDown={e => { e.preventDefault(); handleSelect(item); }}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground transition-colors"
                    >
                      <div className="h-8 w-8 shrink-0 rounded overflow-hidden bg-muted flex items-center justify-center">
                        {thumbReady ? (
                          <img
                            src={`/api/media/${item.id}/thumbnail?v=ready`}
                            alt={getDisplayLabel(item)}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <MimeIcon className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </div>
                      <span className="flex-1 text-sm truncate">{getDisplayLabel(item)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
