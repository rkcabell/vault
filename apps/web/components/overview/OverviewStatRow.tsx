import { formatBytes, formatMimeTag } from "@/lib/media/utils";

const TYPE_BUCKETS: Record<string, { label: string; color: string }> = {
  PDF:  { label: "PDF",  color: "var(--type-pdf)"  },
  IMG:  { label: "IMG",  color: "var(--type-img)"  },
  DOCX: { label: "DOCX", color: "var(--type-docx)" },
  ZIP:  { label: "ZIP",  color: "var(--type-zip)"  },
};

function bucketByLabel(
  breakdown: Array<{ mimeType: string; count: number }>
): Array<{ label: string; color: string; count: number }> {
  const map: Record<string, number> = {};
  for (const { mimeType, count } of breakdown) {
    const label = formatMimeTag(mimeType, null);
    const key = label in TYPE_BUCKETS ? label : "Other";
    map[key] = (map[key] ?? 0) + count;
  }
  const order = ["PDF", "IMG", "DOCX", "ZIP", "Other"];
  return order
    .filter(k => map[k])
    .map(k => ({
      label: k,
      color: TYPE_BUCKETS[k]?.color ?? "var(--type-other)",
      count: map[k]!,
    }));
}

interface Props {
  totalDocs: number;
  storageBytes: number;
  typeBreakdown: Array<{ mimeType: string; count: number }>;
}

export function OverviewStatRow({ totalDocs, storageBytes, typeBreakdown }: Props) {
  const buckets = bucketByLabel(typeBreakdown);
  const maxCount = Math.max(...buckets.map(b => b.count), 1);

  return (
    <>
      <div className="overview-stat-card">
        <div className="overview-stat-label">Documents</div>
        <div className="overview-stat-value">{totalDocs.toLocaleString()}</div>
      </div>

      <div className="overview-stat-card">
        <div className="overview-stat-label">Storage</div>
        <div className="overview-stat-value">{formatBytes(storageBytes)}</div>
      </div>

      {buckets.length > 0 && (
        <div className="overview-stat-card col-span-2 sm:col-span-4 lg:col-span-1">
          <div className="overview-stat-label">By Type</div>
          <div className="mt-2 flex flex-col gap-1.5">
            {buckets.map(b => (
              <div key={b.label} className="flex items-center gap-2">
                <span
                  className="w-8 shrink-0 text-right font-mono text-xs"
                  style={{ color: b.color }}
                >
                  {b.label}
                </span>
                <div className="overview-type-bar flex-1">
                  <div
                    className="h-full rounded-sm"
                    style={{
                      width: `${Math.round((b.count / maxCount) * 100)}%`,
                      backgroundColor: b.color,
                    }}
                  />
                </div>
                <span className="w-10 text-right font-mono text-xs text-muted-foreground">
                  {b.count.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
