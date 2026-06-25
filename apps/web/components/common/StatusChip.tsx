//File: apps/web/components/common/StatusChip.tsx

export function StatusChip({ status }: { status: string }) {
  const normalized = status?.toUpperCase();
  const isPending = normalized === "PENDING";
  const isReady = normalized === "READY";
  const isError = normalized === "ERROR";
  const isUnsupported = normalized === "UNSUPPORTED";
  const color =
    isReady
      ? "bg-green-100 text-green-700 border-green-300"
      : isPending
        ? "bg-yellow-100 text-yellow-800 border-yellow-300"
        : isError
          ? "bg-red-100 text-red-700 border-red-300"
          : "bg-neutral-100 text-neutral-700 border-neutral-300";
  const label =
    isReady
      ? "Ready"
      : isPending
        ? "Pending"
        : isError
          ? "Error"
          : isUnsupported
            ? "Unsupported"
            : status;
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs ${color}`}>
      {label}
    </span>
  );
}
