"use client";

import React, { useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { Button } from "@/components/ui/Button";
import { ConfirmPopover } from "@/components/ui/ConfirmPopover";

type Props = {
  onSuccess: () => void;
  onError: (message: string) => void;
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

// Delete all media for this account.
// For development/testing purposes only, not exposed in production builds.
export default function DevPurgeButton({ onSuccess, onError }: Props) {
  const [isPurging, setIsPurging] = useState(false);
  const [confirmState, setConfirmState] = useState<{ x: number; y: number } | null>(null);

  const doPurge = async () => {
    setIsPurging(true);
    try {
      const res = await apiFetch("/api/media", {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        onError(await readErrorMessage(res));
        return;
      }
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
