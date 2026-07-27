import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { isExcludedFolder } from "../lib/media/indexRoots.js";
import { isBuildDir, isNonContentFile, isJunkDir, isJunkFile } from "../lib/media/contentFilters.js";
import { type DiscoveredFile, isBlacklisted } from "./indexCore.js";

/**
 * The directory-walk rules, in one place.
 *
 * Both the one-shot index scan and the reconcile sweep walk the same roots and
 * must agree exactly on which files count as content: a file the scan skips but
 * the sweep yields would be indexed as new on every sweep, and the reverse would
 * tombstone a file that is sitting right there. Sharing the generator is what
 * keeps the two halves of "is this file in the library?" from drifting apart.
 */
export type WalkFilters = {
  /** Recurse into subdirectories. */
  recursive: boolean;
  /** Skip dotfiles and hidden folders. */
  ignoreHidden: boolean;
  /** Extensions to skip — already normalized (lowercase, no dot). */
  blacklist: string[];
  /** Absolute folders (and their subtrees) to skip. */
  excludeFolders: string[];
  /** Skip build/dependency dirs and non-content file types. */
  skipNonContent: boolean;
};

/** Mutated as the walk passes over junk, so the caller can report how many files
 *  were seen but deliberately not yielded. */
export type WalkStats = { filtered: number };

/**
 * Walk a directory yielding regular files. Symlinks are never followed or
 * yielded — that both prevents directory-loop hangs and stops a symlink from
 * pointing a source read outside the allow-listed root. Files whose extension
 * is blacklisted are skipped (the user's "don't index these filetypes" list);
 * directories on the exclude-list (and everything beneath them) are skipped.
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
    return; // unreadable directory — skip rather than abort the whole walk
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
      // File-level filters — count each pass-over so the caller can report how
      // many files were seen but deliberately not indexed.
      if (isJunkFile(entry.name)) { stats.filtered++; continue; }
      if (st.size === 0) { stats.filtered++; continue; } // empty placeholders/stubs — no content
      if (isBlacklisted(entry.name, filters.blacklist)) { stats.filtered++; continue; }
      if (filters.skipNonContent && isNonContentFile(entry.name)) { stats.filtered++; continue; }
      yield { absPath: full, name: entry.name, size: st.size, mtimeMs: st.mtimeMs };
    }
  }
}
