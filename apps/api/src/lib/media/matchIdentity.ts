/**
 * Decides whether a newly-seen file is an existing item that moved. The
 * operating system reports no move: `a/photo.jpg` becoming `b/photo.jpg` arrives
 * as an unlink and an add. Treating that as a delete and a re-index would throw
 * away the tags, title, bundles and reminders the user added, along with the id
 * behind any bookmarked link, so an unlink tombstones the row instead and an add
 * comes here to find it.
 */

import { sameMtime } from "./sourceMtime.js";

/** A tombstoned row that the incoming file might be. */
export type MoveCandidate = {
  id: string;
  /** Basename of the old source path (not the full path — a move changes dirs). */
  basename: string;
  sizeBytes: number;
  /** Last known file-modified time, in epoch milliseconds. Null on a row
   *  indexed before the column existed, which makes the mtime tiers skip it. */
  mtimeMs: number | null;
  contentHash: string | null;
};

export type IncomingFile = {
  basename: string;
  sizeBytes: number;
  mtimeMs: number | null;
  /** Only present on a second pass — the first pass deliberately does not hash. */
  contentHash?: string | null;
};

/** Most to least certain; logged so a surprising rematch traces to its rule. */
export type MatchVia = "size-mtime-name" | "size-mtime" | "content-hash";

export type MatchResult<C extends MoveCandidate = MoveCandidate> =
  | { kind: "matched"; candidate: C; via: MatchVia }
  /** Ties the caller breaks by hashing and calling again with `contentHash` set. */
  | { kind: "ambiguous"; candidates: C[] }
  | { kind: "none" };

/** Case-insensitive (Windows/macOS name rules) — only ever widens the candidate
 *  set, and ties are resolved by hash rather than guessed at. */
function sameName (a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

/** A real move preserves size and mtime — both must be known to count, and the
 *  mtime only to the precision the column survives (see {@link sameMtime}). */
function sameSizeAndMtime (candidate: MoveCandidate, file: IncomingFile): boolean {
  return candidate.sizeBytes === file.sizeBytes && sameMtime(candidate.mtimeMs, file.mtimeMs);
}

/**
 * Matches `file` against tombstoned `candidates`, cheapest signal first: size and
 * modified time, then content hash. A tier that produces more than one candidate
 * reports `ambiguous` rather than guessing, which would attach one file's history
 * to another. The caller then hashes and calls again with `contentHash` set,
 * which outranks the metadata tiers.
 */
export function matchIdentity<C extends MoveCandidate> (
  file: IncomingFile,
  candidates: C[],
): MatchResult<C> {
  if (candidates.length === 0) return { kind: "none" };

  // A known hash is decisive in the negative: a candidate with a different
  // recorded hash is provably different bytes. Hash-less candidates stay in play.
  const pool = file.contentHash
    ? candidates.filter(c => c.contentHash === null || c.contentHash === file.contentHash)
    : candidates;
  if (pool.length === 0) return { kind: "none" };

  // ...and decisive in the positive: it outranks the metadata tiers once paid
  // for. Prefer a candidate that also kept its name; otherwise the matches are
  // byte-identical and interchangeable.
  if (file.contentHash) {
    const byHash = pool.filter(c => c.contentHash === file.contentHash);
    if (byHash.length > 0) {
      const named = byHash.find(c => sameName(c.basename, file.basename));
      return { kind: "matched", candidate: named ?? byHash[0]!, via: "content-hash" };
    }
    // Every candidate predates hashing. Fall through to the metadata tiers.
  }

  // A tie is `ambiguous` only while a hash could still break it — on the
  // second pass the bytes already agree, so picking one is harmless.
  const settle = (set: C[], via: MatchVia): MatchResult<C> | null => {
    if (set.length === 0) return null;
    if (set.length === 1 || file.contentHash) {
      return { kind: "matched", candidate: set[0]!, via };
    }
    return { kind: "ambiguous", candidates: set };
  };

  const sizeAndMtime = pool.filter(c => sameSizeAndMtime(c, file));

  // Tier 1 — same bytes, same name: a plain move between directories.
  const exact = sizeAndMtime.filter(c => sameName(c.basename, file.basename));
  const tier1 = settle(exact, "size-mtime-name");
  if (tier1) return tier1;

  // Tier 2 — same bytes, different name: a rename.
  const tier2 = settle(sizeAndMtime, "size-mtime");
  if (tier2) return tier2;

  // Metadata found nothing. This is where hashing earns its cost, so ask for
  // one — but only if some candidate has a hash to compare against.
  if (!file.contentHash && pool.some(c => c.contentHash !== null)) {
    return { kind: "ambiguous", candidates: pool };
  }

  return { kind: "none" };
}
