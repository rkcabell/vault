import {
  FolderOpen,
  Images,
  Film,
  Music,
  BookOpen,
  Camera,
  Heart,
  Globe,
  Archive,
  Palette,
  Code2,
  Star,
  type LucideIcon,
} from "lucide-react";

export interface BundleIconDef {
  key: string;       // stored as `icon:${key}` in coverMediaId
  label: string;
  Icon: LucideIcon;
}

export const DEFAULT_BUNDLE_COVER_ID = "icon:folder";

/** Icons available as bundle covers. Stored as `icon:<key>` in coverMediaId. */
export const BUNDLE_ICONS: BundleIconDef[] = [
  { key: "images",    label: "Photos",      Icon: Images    },
  { key: "film",      label: "Video",       Icon: Film      },
  { key: "music",     label: "Music",       Icon: Music     },
  { key: "book-open", label: "Documents",   Icon: BookOpen  },
  { key: "camera",    label: "Camera",      Icon: Camera    },
  { key: "heart",     label: "Favorites",   Icon: Heart     },
  { key: "globe",     label: "Travel",      Icon: Globe     },
  { key: "archive",   label: "Archive",     Icon: Archive   },
  { key: "palette",   label: "Art",         Icon: Palette   },
  { key: "code2",     label: "Code",        Icon: Code2     },
  { key: "star",      label: "Starred",     Icon: Star      },
];

/** Default icon shown when no cover is set. */
export const DEFAULT_BUNDLE_ICON: LucideIcon = FolderOpen;

/**
 * Resolves a coverMediaId to a LucideIcon if it's an icon cover,
 * or null if it's a real media ID (or not set).
 */
export function getBundleIcon(coverMediaId: string | null | undefined): LucideIcon | null {
  if (!coverMediaId?.startsWith("icon:")) return null;
  const key = coverMediaId.slice(5);
  if (key === "folder") return DEFAULT_BUNDLE_ICON;
  return BUNDLE_ICONS.find(d => d.key === key)?.Icon ?? null;
}
