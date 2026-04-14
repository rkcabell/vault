import Link from "next/link";
import { listMedia } from "@/lib/api.server";
import { formatMimeTag, describeInboxStatus } from "@/lib/media/utils";
import { OverviewRemindersCard } from "@/components/reminders/OverviewRemindersCard";

export default async function OverviewPage() {
  const recent = (await listMedia({ q: "" })).slice(0, 9);

  const inbox = recent
    .filter((m) => {
      if (m.thumbState === "PENDING" || m.textState === "PENDING") return true;
      // thumbState failure = icon fallback, not actionable
      if (m.textState === "ERROR") return true;
      // textState FAILED = not supported / retries exhausted — not actionable
      return false;
    })
    .slice(0, 8);

  return (
    <div className="overview-page">
      <main className="mx-auto max-w-6xl space-y-8 p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Home</h1>
          <p className="text-sm text-muted-foreground">
            {inbox.length
              ? `${inbox.length} item(s) still processing or awaiting review`
              : "Nothing pending. You're caught up."}
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

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Inbox</h2>
        {inbox.length === 0 ? (
          <div className="overview-card--muted rounded-2xl border p-6 text-sm text-muted-foreground">
            No items in the inbox.
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {inbox.map((m) => (
              <Link
                key={m.id}
                href={`/media/${m.id}`}
                className="overview-card overview-card--muted rounded-2xl border p-4"
              >
                <div className="truncate text-sm font-medium">
                  {m.title || m.id}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {describeInboxStatus(m.thumbState, m.textState)}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <OverviewRemindersCard />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Recent</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {recent.map((m) => (
            <Link
              key={m.id}
              href={`/media/${m.id}`}
              className="overview-card rounded-2xl border p-4"
            >
              <div className="truncate text-sm font-medium">
                {m.title || m.id}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {formatMimeTag(m.mimeType, m.filename)}
              </div>
            </Link>
          ))}
        </div>
      </section>
      </main>
    </div>
  );
}
