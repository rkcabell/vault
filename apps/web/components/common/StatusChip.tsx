export default function StatusChip({ status }: { status: string }) {
  const color = status === "READY" ? "bg-green-100 text-green-700 border-green-300"
              : status === "PROCESSING" ? "bg-yellow-100 text-yellow-800 border-yellow-300"
              : "bg-neutral-100 text-neutral-700 border-neutral-300";
  return <span className={`inline-block rounded border px-2 py-0.5 text-xs ${color}`}>{status}</span>;
}