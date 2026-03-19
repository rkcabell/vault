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
          await fetch(`/api/media/${item.id}`, {
            method: "DELETE",
            credentials: "include",
          });
        }
      } while (cursor);
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
        variant="outline"
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
