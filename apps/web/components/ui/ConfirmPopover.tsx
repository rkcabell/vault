// File: apps/web/components/ui/ConfirmPopover.tsx
"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";

interface ConfirmPopoverProps {
  open: boolean;
  x: number;
  y: number;
  /** When provided, the popover centers on x, appears above y, and sizes to this width + padding. */
  anchorWidth?: number;
  /** When provided, positions the popover using CSS bottom instead of top (px from bottom of viewport). */
  bottomOffset?: number;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: "destructive" | "default" | "outline";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmPopover({
  open,
  x,
  y,
  anchorWidth,
  bottomOffset,
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  confirmVariant = "destructive",
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

  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;

  let W: number;
  let left: number;
  let top: number;
  const H = 108;

  if (anchorWidth !== undefined) {
    // Anchor mode: center on x, width tracks the button
    W = Math.max(anchorWidth + 48, 148);
    left = Math.max(8, Math.min(x - W / 2, vw - W - 8));
    top = bottomOffset !== undefined ? 0 : Math.max(8, y - H - 8);
  } else {
    // Legacy cursor mode
    W = 224;
    left = Math.max(8, Math.min(x, vw - W - 8));
    top = y + 12 + H > vh ? y - H - 8 : y + 12;
  }

  return (
    <div
      ref={ref}
      style={{ position: "fixed", left, ...(bottomOffset !== undefined ? { bottom: bottomOffset } : { top }), width: W, zIndex: 9999 }}
      className="rounded-lg border bg-background p-3 shadow-xl"
      role="dialog"
      aria-modal="false"
    >
      <p className={`mb-3 text-sm leading-snug text-foreground${anchorWidth !== undefined ? " text-center" : ""}`}>
        {message}
      </p>
      {anchorWidth !== undefined ? (
        <div className="flex flex-col gap-2">
          <Button size="sm" variant={confirmVariant} onClick={onConfirm}>
            {confirmLabel}
          </Button>
          <Button size="sm" variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button size="sm" variant={confirmVariant} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
