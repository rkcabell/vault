import Link from "next/link";
import { fetchCategoryBreakdown, fetchMediaStats, fetchWorkerCounts } from "@/lib/api.server";
import { OverviewRemindersCard } from "@/components/reminders/OverviewRemindersCard";
import { LibraryUpdateBanner } from "@/components/media/LibraryUpdateBanner";
import { OverviewVizPanel } from "@/components/overview/OverviewVizPanel";
import { OverviewHealthPoller } from "@/components/overview/OverviewHealthPoller";

export default async function OverviewPage() {
  const [stats, categoryBreakdown, workerCounts] = await Promise.all([
    fetchMediaStats(),
    fetchCategoryBreakdown(),
    fetchWorkerCounts(),
  ]);

  const mediaStats = stats ?? { totalDocs: 0, storageBytes: 0, typeBreakdown: [] };

  return (
    <div className="overview-page">
      <main className="mx-auto max-w-6xl space-y-8 p-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Home</h1>
            <p className="text-sm text-muted-foreground">
              {mediaStats.totalDocs > 0
                ? `${mediaStats.totalDocs.toLocaleString()} documents in your vault`
                : "Your document vault"}
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              className="overview-secondary-btn rounded-md border px-3 py-2 text-sm"
              href="/library"
            >
              Open Library
            </Link>
            <Link
              className="overview-secondary-btn rounded-md bg-black px-3 py-2 text-sm text-white hover:opacity-90 dark:bg-white dark:text-black"
              href="/upload"
            >
              Upload
            </Link>
          </div>
        </header>

        <OverviewRemindersCard />

        <LibraryUpdateBanner />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_20rem]">
          <OverviewVizPanel categories={categoryBreakdown.categories} mediaStats={mediaStats} />

          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold shrink-0">System Status</h2>
            <div className="overview-card rounded-2xl p-4">
              <OverviewHealthPoller initialWorkers={workerCounts} />
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
