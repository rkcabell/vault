"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Container, PageHeader } from "@/components/common";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { apiFetch } from "@/lib/apiFetch";
import { formatBytes } from "@/lib/media/utils";
import { startBulkDelete, getDeleteStatus } from "@/lib/media/deleting";
import { Loader2, ScanSearch } from "lucide-react";

type DuplicateItem = {
  id: string;
  title: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sourcePath: string | null;
  createdAt: string;
  thumbState: string;
  thumbnailKey: string | null;
};

type DuplicateGroup = {
  contentHash: string;
  sizeBytes: number;
  items: DuplicateItem[];
};

type DuplicatesResponse = {
  groups: DuplicateGroup[];
  unhashedCount: number;
};

/** Default copy to keep: the first in-place original, else the oldest copy. */
function defaultKeepId (group: DuplicateGroup): string {
  return group.items.find(i => i.sourcePath)?.id ?? group.items[0]?.id ?? "";
}

function formatDate (value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

export default function DuplicatesPage () {
  const [data, setData] = useState<DuplicatesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [scanStarted, setScanStarted] = useState(false);
  const [isScanRequestPending, setIsScanRequestPending] = useState(false);
  // contentHash → mediaId the user chose to keep (defaults applied at render).
  const [keepChoice, setKeepChoice] = useState<Record<string, string>>({});
  const [confirmingGroup, setConfirmingGroup] = useState<string | null>(null);
  const [deletingGroups, setDeletingGroups] = useState<Set<string>>(new Set());
  const dataRef = useRef<DuplicatesResponse | null>(null);

  const fetchGroups = useCallback(async (silent = false) => {
    if (!silent) setIsLoading(true);
    try {
      const res = await apiFetch("/api/media/duplicates", { credentials: "include" });
      if (!res.ok) {
        setError(`Could not load duplicates (${res.status}).`);
        return;
      }
      const body = (await res.json()) as DuplicatesResponse;
      dataRef.current = body;
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load duplicates.");
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchGroups();
  }, [fetchGroups]);

  // While a scan is running, refresh periodically until everything is hashed.
  useEffect(() => {
    if (!scanStarted) return;
    const interval = setInterval(() => {
      if ((dataRef.current?.unhashedCount ?? 0) === 0) {
        setScanStarted(false);
        return;
      }
      void fetchGroups(true);
    }, 5000);
    return () => clearInterval(interval);
  }, [scanStarted, fetchGroups]);

  const handleScan = async () => {
    setIsScanRequestPending(true);
    setError(null);
    try {
      const res = await apiFetch("/api/media/duplicates/scan", { method: "POST", credentials: "include" });
      if (!res.ok) {
        setError(`Could not start scan (${res.status}).`);
        return;
      }
      setScanStarted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start scan.");
    } finally {
      setIsScanRequestPending(false);
    }
  };

  const handleDeleteOthers = async (group: DuplicateGroup) => {
    const keepId = keepChoice[group.contentHash] ?? defaultKeepId(group);
    const ids = group.items.filter(i => i.id !== keepId).map(i => i.id);
    if (ids.length === 0) return;
    setConfirmingGroup(null);
    setDeletingGroups(prev => new Set(prev).add(group.contentHash));
    try {
      const { jobId } = await startBulkDelete({ ids });
      // Wait for the background delete to finish, then refresh the groups.
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const status = await getDeleteStatus(jobId);
        if (!status || status.done) break;
      }
      await fetchGroups(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setDeletingGroups(prev => {
        const next = new Set(prev);
        next.delete(group.contentHash);
        return next;
      });
    }
  };

  const groups = data?.groups ?? [];
  const unhashedCount = data?.unhashedCount ?? 0;

  return (
    <Container>
      <PageHeader
        title="Duplicates"
        description="Byte-identical copies of the same file, matched by content hash."
      />

      <p className="mb-6 max-w-3xl text-sm text-muted-foreground">
        Deleting an indexed copy removes it from Vault only — the original file on
        your disk is never touched. Deleting an uploaded copy removes the file from
        Vault&apos;s managed storage.
      </p>

      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

      {unhashedCount > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-md border border-border p-4">
          <ScanSearch className="h-5 w-5 shrink-0 text-muted-foreground" />
          <span className="text-sm">
            {unhashedCount} item{unhashedCount === 1 ? "" : "s"} haven&apos;t been scanned for
            duplicates yet.
          </span>
          {scanStarted ? (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Scanning in the background…
            </span>
          ) : (
            <Button size="sm" onClick={handleScan} disabled={isScanRequestPending}>
              {isScanRequestPending ? "Starting…" : "Scan now"}
            </Button>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading duplicates…
        </div>
      ) : groups.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          <p className="text-lg">No duplicates found</p>
          <p className="mt-1 text-sm">
            {unhashedCount > 0
              ? "Run a scan to check the remaining items."
              : "Every scanned item has unique content."}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map(group => {
            const keepId = keepChoice[group.contentHash] ?? defaultKeepId(group);
            const extraCount = group.items.length - 1;
            const isDeleting = deletingGroups.has(group.contentHash);
            return (
              <Card key={group.contentHash}>
                <CardContent className="space-y-4 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      {group.items.length} identical copies · {formatBytes(group.sizeBytes)} each
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      sha256:{group.contentHash.slice(0, 16)}…
                    </span>
                  </div>

                  <ul className="space-y-2">
                    {group.items.map(item => (
                      <li
                        key={item.id}
                        className={`flex items-center gap-3 rounded-md border p-2 ${
                          item.id === keepId ? "border-primary/60" : "border-border"
                        }`}
                      >
                        <input
                          type="radio"
                          name={`keep-${group.contentHash}`}
                          checked={item.id === keepId}
                          disabled={isDeleting}
                          onChange={() =>
                            setKeepChoice(prev => ({ ...prev, [group.contentHash]: item.id }))
                          }
                          aria-label={`Keep ${item.title}`}
                          className="h-4 w-4 shrink-0"
                        />
                        {item.thumbState === "READY" ? (
                          <img
                            src={`/api/media/${item.id}/thumbnail`}
                            alt=""
                            className="h-12 w-12 shrink-0 rounded object-cover"
                          />
                        ) : (
                          <div className="h-12 w-12 shrink-0 rounded bg-muted" />
                        )}
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/media/${item.id}`}
                            className="block truncate text-sm font-medium hover:underline"
                          >
                            {item.title || item.filename}
                          </Link>
                          <p className="truncate font-mono text-xs text-muted-foreground">
                            {item.sourcePath ?? "Vault managed storage"}
                          </p>
                        </div>
                        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                          {item.sourcePath ? "In-place" : "Managed"}
                        </span>
                        <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                          {formatDate(item.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>

                  <div className="flex items-center gap-2">
                    {isDeleting ? (
                      <span className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Deleting…
                      </span>
                    ) : confirmingGroup === group.contentHash ? (
                      <>
                        <Button size="sm" variant="destructive" onClick={() => void handleDeleteOthers(group)}>
                          Confirm delete {extraCount} cop{extraCount === 1 ? "y" : "ies"}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setConfirmingGroup(null)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirmingGroup(group.contentHash)}
                      >
                        Keep selected, delete {extraCount} other{extraCount === 1 ? "" : "s"}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </Container>
  );
}
