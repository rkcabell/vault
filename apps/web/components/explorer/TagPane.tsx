//File: apps/web/components/explorer/TagPane.tsx
const EXAMPLE = ["car", "finance", "insurance", "id", "warranty", "personal"];

export default function TagPane({ selected, onToggle }: { selected: string[]; onToggle: (t: string)=>void }) {
  return (
    <div className="rounded border bg-white p-3">
      <h3 className="mb-2 font-medium">Tags</h3>
      <ul className="flex flex-col gap-1">
        {EXAMPLE.map((t)=> {
          const active = selected.includes(t);
          return (
            <li key={t}>
              <button
                onClick={()=>onToggle(t)}
                className={`w-full rounded border px-2 py-1 text-left text-sm ${active ? "bg-black text-white" : ""}`}
              >#{t}</button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
