// File: apps/web/components/ui/ConfirmPopover.tsx
"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";

interface ConfirmPopoverProps {
  open: boolean;
  x: number;
  y: number;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmPopover({
  open,
  x,
  y,
  message,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
}: ConfirmPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open, onCancel]);

  if (!open) return null;

  const W = 224;
  const H = 96;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const left = Math.max(8, Math.min(x, vw - W - 8));
  const top = y + 12 + H > vh ? y - H - 8 : y + 12;

  return (
    <div
      ref={ref}
      style={{ position: "fixed", left, top, width: W, zIndex: 9999 }}
      className="rounded-lg border bg-background p-3 shadow-xl"
      role="dialog"
      aria-modal="false"
    >
      <p className="mb-3 text-sm leading-snug text-foreground">{message}</p>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="destructive" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
