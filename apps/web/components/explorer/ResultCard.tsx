//File: apps/web/components/explorer/ResultCard.tsx
import Link from "next/link";
import { StatusChip } from "@/components/common";

type MediaItem = {
  id: string;
  title?: string | null;
  filename?: string | null;
  status?: string;
  thumbnailKey?: string | null;
  tags?: string[];
};

type MediaRoute = `/media/${string}`;

export default function ResultCard({ item }: { item: MediaItem }) {
  const id = item.id;
  return (
    <Link href={{ pathname: "/media/[id]", query: { id } }} className="block rounded border bg-white p-2 hover:shadow">
      <div className="aspect-[4/3] overflow-hidden rounded bg-neutral-100">
        {item.thumbnailKey ? (
          // We rely on server route /media/:id/thumbnail for signed URL in detail page.
          <img src={`/api/proxy/thumb/${item.id}`} alt={item.title ?? "thumb"} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs opacity-60">No thumbnail</div>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="truncate text-sm">{item.title ?? item.filename ?? "Untitled"}</div>
        <StatusChip status={item.status ?? "UNKNOWN"} />
      </div>
      {item.tags?.length ? (
        <div className="mt-1 line-clamp-1 text-xs opacity-70">#{item.tags.join(" #")}</div>
      ) : null}
    </Link>
  );
}
