import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { isExcludedFolder } from "../lib/media/indexRoots.js";
import {
  isBuildDir,
  isNonContentFile,
  isJunkDir,
  isJunkFile,
} from "../lib/media/contentFilters.js";
import { type DiscoveredFile, isBlacklisted } from "./indexCore.js";

/**
 * Walks a directory tree and yields the files worth indexing, applying the
 * user's filters as it goes.
 */

/** What the walk skips, and whether it descends into subdirectories. */
export type WalkFilters = {
  recursive: boolean;
  ignoreHidden: boolean;
  blacklist: string[];
  excludeFolders: string[];
  skipNonContent: boolean;
};

/** Running count of the files the filters skipped. */
export type WalkStats = { filtered: number };

/**
 * Yields every regular file under `dir`. A symlink is never followed, because it
 * could point outside the allowed roots.
 */
export async function* walkFiles (
  dir: string,
  filters: WalkFilters,
  stats: WalkStats,
): AsyncGenerator<DiscoveredFile> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory, skip
  }
  for (const entry of entries) {
    if (filters.ignoreHidden && entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    let st;
    try {
      st = await lstat(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (isJunkDir(entry.name)) continue;
      if (isExcludedFolder(full, filters.excludeFolders)) continue;
      if (filters.skipNonContent && isBuildDir(entry.name)) continue;
      if (filters.recursive) yield* walkFiles(full, filters, stats);
    } else if (st.isFile()) {
      if (isJunkFile(entry.name)) {
        stats.filtered++;
        continue;
      }
      if (st.size === 0) {
        stats.filtered++;
        continue;
      }
      if (isBlacklisted(entry.name, filters.blacklist)) {
        stats.filtered++;
        continue;
      }
      if (filters.skipNonContent && isNonContentFile(entry.name)) {
        stats.filtered++;
        continue;
      }
      yield { absPath: full, name: entry.name, size: st.size, mtimeMs: st.mtimeMs };
    }
  }
}
