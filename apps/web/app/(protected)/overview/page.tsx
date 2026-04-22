import Link from "next/link";
import { listMedia, fetchInit, fetchWorkerCounts } from "@/lib/api.server";
import { OverviewRemindersCard } from "@/components/reminders/OverviewRemindersCard";
import { OverviewStatRow } from "@/components/overview/OverviewStatRow";
import { OverviewDocTable } from "@/components/overview/OverviewDocTable";
import { OverviewWorkerPoller } from "@/components/overview/OverviewWorkerPoller";
import { OverviewHealthPoller } from "@/components/overview/OverviewHealthPoller";

export default async function OverviewPage() {
  const [initData, allMedia, workerCounts] = await Promise.all([
    fetchInit(),
    listMedia({ q: "" }),
    fetchWorkerCounts(),
  ]);

  const recent = allMedia.slice(0, 15);
  const mediaStats = initData?.mediaStats ?? { totalDocs: 0, storageBytes: 0, typeBreakdown: [] };

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

        {/* Stat row: server-rendered docs/storage/type + live-polling worker queues */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
          <OverviewStatRow
            totalDocs={mediaStats.totalDocs}
            storageBytes={mediaStats.storageBytes}
            typeBreakdown={mediaStats.typeBreakdown}
          />
          <OverviewWorkerPoller initial={workerCounts} />
        </div>

        <OverviewRemindersCard />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_8rem]">
          <section className="space-y-3 min-w-0">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Recent</h2>
              <Link href="/library" className="text-xs text-muted-foreground hover:underline">
                See all →
              </Link>
            </div>
            <div className="overview-card rounded-2xl border overflow-hidden">
              <OverviewDocTable docs={recent} />
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold shrink-0">System Status</h2>
            <div className="flex-1">
              <OverviewHealthPoller />
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
