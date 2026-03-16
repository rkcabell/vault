"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

type Props = {
  buildQuery: (cursor?: string) => string;
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

export default function DevPurgeButton({ buildQuery, onSuccess, onError }: Props) {
  const [isPurging, setIsPurging] = useState(false);

  const handleDevPurge = async () => {
    if (isPurging) return;
    const confirmed = window.confirm(
      "Delete all uploaded files for this account? This cannot be undone.",
    );
    if (!confirmed) return;

    setIsPurging(true);
    try {
      let cursor: string | null = null;
      do {
        const params = new URLSearchParams(buildQuery(cursor ?? undefined));
        params.set("limit", "100");
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
    <Button variant="outline" size="sm" onClick={handleDevPurge} disabled={isPurging}>
      {isPurging ? "Deleting..." : "Delete All (Dev)"}
    </Button>
  );
}
