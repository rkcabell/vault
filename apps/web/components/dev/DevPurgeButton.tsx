"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmPopover } from "@/components/ui/ConfirmPopover";
import { useDeleteProgress } from "@/components/contexts/DeleteProgressContext";

type Props = {
  onSuccess: () => void;
  onError: (message: string) => void;
};

// Delete all media for this account via the shared delete-progress context so
// the LibraryUpdateBanner, reconcile re-fetch, and sidebar tag refresh all fire
// exactly as they do for a normal bulk delete.
// For development/testing purposes only, not exposed in production builds.
export default function DevPurgeButton({ onSuccess, onError }: Props) {
  const { start } = useDeleteProgress();
  const [isPurging, setIsPurging] = useState(false);
  const [confirmState, setConfirmState] = useState<{ x: number; y: number } | null>(null);

  const doPurge = async () => {
    setIsPurging(true);
    try {
      await start({ query: "" }); // empty query = delete everything for this user
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
