"use client";

import Link from "next/link";
import { formatBytes, formatMimeTag } from "@/lib/media/utils";
import type { MediaListItem } from "@vault/types";

function fmtRelative(iso: string): string {
  const diffSec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (diffSec < 60)    return rtf.format(-diffSec, "second");
  if (diffSec < 3600)  return rtf.format(-Math.round(diffSec / 60), "minute");
  if (diffSec < 86400) return rtf.format(-Math.round(diffSec / 3600), "hour");
  return rtf.format(-Math.round(diffSec / 86400), "day");
}

// FAILED = format not supported / retries exhausted (not actionable, not an error)
// ERROR  = retriable failure (actionable)
function StatusIcon({ thumbState, textState }: { thumbState: MediaListItem["thumbState"]; textState: MediaListItem["textState"] }) {
  const isPending    = thumbState === "PENDING" || textState === "PENDING";
  const isError      = textState === "ERROR" || thumbState === "ERROR";
  const isUnsupported = !isPending && !isError && (textState === "FAILED" || thumbState === "FAILED");

  if (isPending)     return <span title="Processing" className="text-xs" style={{ color: "var(--reminder-today)" }}>…</span>;
  if (isError)       return <span title="Processing error" className="text-xs" style={{ color: "var(--reminder-overdue)" }}>✕</span>;
  if (isUnsupported) return <span title="Not supported for this format" className="text-xs text-muted-foreground">–</span>;
  return <span title="Ready" className="text-xs" style={{ color: "var(--status-healthy)" }}>✓</span>;
}

function rowClass(item: MediaListItem): string {
  // Only highlight ERROR (retriable), not FAILED (unsupported format)
  if (item.textState === "ERROR" || item.thumbState === "ERROR") {
    return "overview-doc-table__row overview-doc-table__row--inbox-error";
  }
  if (item.thumbState === "PENDING" || item.textState === "PENDING") {
    return "overview-doc-table__row overview-doc-table__row--inbox";
  }
  return "overview-doc-table__row";
}

interface Props {
  docs: MediaListItem[];
}

export function OverviewDocTable({ docs }: Props) {
  if (docs.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">No documents yet.</div>
    );
  }

  return (
    <table className="overview-doc-table">
      <thead>
        <tr>
          <th style={{ width: "4rem" }}>Type</th>
          <th>Name</th>
          <th style={{ width: "6rem" }}>Size</th>
          <th style={{ width: "8rem" }}>Added</th>
          <th style={{ width: "2.5rem" }}>Status</th>
        </tr>
      </thead>
      <tbody>
        {docs.map(doc => (
          <tr key={doc.id} className={rowClass(doc)}>
            <td>
              <span className="overview-type-badge">
                {formatMimeTag(doc.mimeType, doc.filename)}
              </span>
            </td>
            <td>
              <Link
                href={`/media/${doc.id}`}
                className="block max-w-xs truncate text-sm font-medium hover:underline"
              >
                {doc.title || doc.filename}
              </Link>
            </td>
            <td className="font-mono text-xs text-muted-foreground">
              {formatBytes(doc.sizeBytes ?? null)}
            </td>
            <td className="text-xs text-muted-foreground">
              {fmtRelative(doc.createdAt)}
            </td>
            <td className="text-center">
              <StatusIcon thumbState={doc.thumbState} textState={doc.textState} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
