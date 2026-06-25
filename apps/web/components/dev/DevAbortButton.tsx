"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { Button } from "@/components/ui/Button";

type Props = {
  onSuccess: (cleared: string[]) => void;
  onError: (message: string) => void;
  onAbortStart?: () => void;
};

async function readErrorMessage(response: Response) {
  try {
    const data = await response.json();
    if (data?.error || data?.message) return data.error || data.message;
  } catch {
    // ignore
  }
  return `Failed to abort processing (${response.status})`;
}

// Stop the index walk and drain the index queue, but leave thumb/OCR jobs
// already enqueued to finish. For development/testing only; not shown in prod builds.
export default function DevAbortButton({ onSuccess, onError, onAbortStart }: Props) {
  const [isAborting, setIsAborting] = useState(false);

  const doAbort = async () => {
    if (isAborting) return;
    onAbortStart?.();
    setIsAborting(true);
    try {
      const res = await apiFetch("/api/media/abort", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        onError(await readErrorMessage(res));
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { cleared?: string[] };
      onSuccess(data.cleared ?? []);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to abort processing.");
    } finally {
      setIsAborting(false);
    }
  };

  return (
    <Button
      variant="destructive"
      size="sm"
      onClick={() => void doAbort()}
      disabled={isAborting}
    >
      {isAborting ? "Aborting..." : "Abort"}
    </Button>
  );
}
