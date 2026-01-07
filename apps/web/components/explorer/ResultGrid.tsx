import ResultCard from "./ResultCard";

export default function ResultGrid({ items, loading }: { items: any[]; loading: boolean }) {
  if (loading) return <div className="opacity-60">Loadingâ€¦</div>;
  if (!items?.length) return <div className="opacity-60">No results</div>;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
      {items.map((it) => <ResultCard key={it.id} item={it} />)}
    </div>
  );
}