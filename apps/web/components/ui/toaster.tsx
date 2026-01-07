// File: apps/web/components/ui/toaster.tsx
"use client";

import * as React from "react";

type ToastVariant = "default" | "success" | "error";
type ToastItem = { id: number; message: string; variant: ToastVariant; duration: number };

// Tiny event bus so we don't rely on a mutable module variable (plays nicer with HMR)
const bus = new EventTarget();

export function toast(
  message: string,
  opts: Partial<Pick<ToastItem, "variant" | "duration">> = {}
) {
  const item: ToastItem = {
    id: Date.now(),
    message,
    variant: opts.variant ?? "default",
    duration: Math.max(0, opts.duration ?? 3000),
  };
  bus.dispatchEvent(new CustomEvent("toast", { detail: item }));
}

export function Toaster() {
  const [items, setItems] = React.useState<ToastItem[]>([]);

  React.useEffect(() => {
    function onToast(e: Event) {
      const t = (e as CustomEvent<ToastItem>).detail;
      setItems((prev) => [...prev, t]);
      if (t.duration > 0) {
        setTimeout(() => {
          setItems((prev) => prev.filter((x) => x.id !== t.id));
        }, t.duration);
      }
    }
    bus.addEventListener("toast", onToast);
    return () => bus.removeEventListener("toast", onToast);
  }, []);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] mx-auto flex w-full max-w-sm flex-col gap-2 px-3">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          aria-live="polite"
          className={[
            "pointer-events-auto rounded-md border px-3 py-2 text-sm shadow transition",
            "bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100",
            // borders (use your tokens if you defined them)
            "border-neutral-200 dark:border-neutral-800",
            t.variant === "success" && "ring-1 ring-emerald-400/50",
            t.variant === "error" && "ring-1 ring-rose-400/50",
          ].join(" ")}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
