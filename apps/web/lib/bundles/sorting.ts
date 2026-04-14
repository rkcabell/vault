import type { BundleDetail } from "@vault/types";

export const SORT_OPTIONS = [
  { value: "addedAt_desc",  label: "Newest"    },
  { value: "addedAt_asc",   label: "Oldest"    },
  { value: "title_asc",     label: "Name A-Z"  },
  { value: "title_desc",    label: "Name Z-A"  },
  { value: "size_desc",     label: "Largest"   },
  { value: "size_asc",      label: "Smallest"  },
  { value: "mimeType_asc",  label: "Type"      },
] as const;

export type SortValue = (typeof SORT_OPTIONS)[number]["value"];
export const DEFAULT_SORT: SortValue = "addedAt_desc";

export function sortItems(items: BundleDetail["items"], sort: SortValue): BundleDetail["items"] {
  const sorted = [...items];
  switch (sort) {
    case "addedAt_desc":  return sorted.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    case "addedAt_asc":   return sorted.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
    case "title_asc":     return sorted.sort((a, b) => a.title.localeCompare(b.title));
    case "title_desc":    return sorted.sort((a, b) => b.title.localeCompare(a.title));
    case "size_desc":     return sorted.sort((a, b) => b.sizeBytes - a.sizeBytes);
    case "size_asc":      return sorted.sort((a, b) => a.sizeBytes - b.sizeBytes);
    case "mimeType_asc":  return sorted.sort((a, b) => a.mimeType.localeCompare(b.mimeType));
  }
}
