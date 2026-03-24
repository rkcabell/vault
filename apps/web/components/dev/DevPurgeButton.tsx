"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmPopover } from "@/components/ui/ConfirmPopover";

type Props = {
  onSuccess: () => void;
  onError: (message: string) => void;
};

type MediaListResponse = {
  items: { id: string }[];
  nextCursor?: string | null;
};

type TagsListResponse = {
  tags?: { name: string }[];
};

async function readErrorMessage(response: Response) {
  try {
    const data = await response.json();
    if (data?.error || data?.message) return data.error || data.message;
  } catch {
    // ignore
  }
  return `Failed to load media (${response.status})`;
}

export default function DevPurgeButton({ onSuccess, onError }: Props) {
  const [isPurging, setIsPurging] = useState(false);
  const [confirmState, setConfirmState] = useState<{ x: number; y: number } | null>(null);

  const deleteAllTags = async () => {
    while (true) {
      const listRes = await fetch("/api/tags?limit=200&offset=0", {
        method: "GET",
        credentials: "include",
      });
      if (!listRes.ok) {
        onError(await readErrorMessage(listRes));
        return false;
      }

      const data = (await listRes.json()) as TagsListResponse;
      const tags = data.tags ?? [];
      if (tags.length === 0) return true;

      for (const tag of tags) {
        const delRes = await fetch(`/api/tags/${encodeURIComponent(tag.name)}`, {
          method: "DELETE",
          credentials: "include",
        });
        if (!delRes.ok) {
          onError(await readErrorMessage(delRes));
          return false;
        }
      }
    }
  };

  const doPurge = async () => {
    setIsPurging(true);
    try {
      let cursor: string | null = null;
      do {
        const params = new URLSearchParams({ limit: "100" });
        if (cursor) params.set("cursor", cursor);
        const res = await fetch(`/api/media?${params.toString()}`, {
          method: "GET",
          credentials: "include",
        });
        if (!res.ok) {
          onError(await readErrorMessage(res));
          return;
        }
        const data = (await res.json()) as MediaListResponse;
        cursor = data.nextCursor ?? null;
        for (const item of data.items ?? []) {
          const delRes = await fetch(`/api/media/${item.id}`, {
            method: "DELETE",
            credentials: "include",
          });
          if (!delRes.ok) {
            onError(await readErrorMessage(delRes));
            return;
          }
        }
      } while (cursor);

      const tagsDeleted = await deleteAllTags();
      if (!tagsDeleted) return;

      onSuccess();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to delete media.");
    } finally {
      setIsPurging(false);
    }
  };

  return (
    <>
      <Button
        variant="destructive"
        size="sm"
        onClick={(e) => { if (!isPurging) setConfirmState({ x: e.clientX, y: e.clientY }); }}
        disabled={isPurging}
      >
        {isPurging ? "Deleting..." : "Delete All (Dev)"}
      </Button>
      <ConfirmPopover
        open={confirmState !== null}
        x={confirmState?.x ?? 0}
        y={confirmState?.y ?? 0}
        message="Delete all uploaded files for this account? This cannot be undone."
        onConfirm={() => { setConfirmState(null); void doPurge(); }}
        onCancel={() => setConfirmState(null)}
      />
    </>
  );
}
