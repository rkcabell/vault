//File: apps/web/components/explorer/ResultGrid.tsx
import ResultCard, { type MediaItem } from "@/components/explorer/ResultCard";

export default function ResultGrid({ items, loading }: { items: MediaItem[]; loading: boolean }) {
  if (loading) return <div className="opacity-60">Loading…</div>;
  if (!items?.length) return <div className="opacity-60">No results</div>;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
      {items.map((it) => <ResultCard key={it.id} item={it} />)}
    </div>
  );
}
