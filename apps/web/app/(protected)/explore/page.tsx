import { listMediaSizes } from "@/lib/api.server";
import { ExploreTreemapView } from "@/components/overview/viz/ExploreTreemapView";

export default async function ExplorePage() {
  const items = await listMediaSizes();

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Explore</h1>
        <p className="text-sm text-muted-foreground">
          Storage by file — the largest files shown exactly, plus a representative
          sample of smaller files (hatched). Tile area tracks real storage.
        </p>
      </div>

      <ExploreTreemapView docs={items} />
    </div>
  );
}
