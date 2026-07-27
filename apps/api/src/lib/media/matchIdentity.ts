/**
 * Decide whether a newly-seen file is really an existing item that moved.
 *
 * The OS gives no "move" event: dragging `a/photo.jpg` to `b/photo.jpg` arrives
 * as `unlink a/photo.jpg` + `add b/photo.jpg`, and a rename looks identical.
 * Treating those as a delete plus a fresh index destroys everything the user
 * added — tags, edited title, starred state, bundle membership, reminders,
 * extracted text, and the stable `Media.id` behind any bookmarked link.
 *
 * So the unlink side tombstones the row (`Media.missingSince`) rather than
 * deleting it, and the add side calls this to look for the row it belongs to.
 *
 * Pure and I/O-free on purpose: both the live watcher and the reconciliation
 * pass feed it candidates they already have in hand, and it is exhaustively
 * testable without a filesystem, a database, or a clock.
 */

/** A tombstoned row that the incoming file might actually be. */
export type MoveCandidate = {
  id: string;
  /** Basename of the old source path (not the full path — a move changes dirs). */
  basename: string;
  sizeBytes: number;
  /** Last known filesystem mtime in epoch ms; null on rows indexed before the
   *  column existed, which simply makes the mtime tiers skip them. */
  mtimeMs: number | null;
  contentHash: string | null;
};

/** The file the watcher just saw appear. */
export type IncomingFile = {
  basename: string;
  sizeBytes: number;
  mtimeMs: number | null;
  /** Only present on a second pass — the first pass deliberately does not hash. */
  contentHash?: string | null;
};

/**
 * How the match was established, most to least certain. Callers log this so a
 * surprising rematch can be traced back to the rule that produced it.
 */
export type MatchVia = "size-mtime-name" | "size-mtime" | "content-hash";

export type MatchResult<C extends MoveCandidate = MoveCandidate> =
  /** Exactly one candidate is this file. Update that row in place. */
  | { kind: "matched"; candidate: C; via: MatchVia }
  /** Several candidates are indistinguishable by cheap metadata. Hash the
   *  incoming file and call again with `contentHash` set to break the tie. */
  | { kind: "ambiguous"; candidates: C[] }
  /** Nothing plausible. The caller indexes it as a genuinely new file. */
  | { kind: "none" };

/** Windows and macOS are case-insensitive about filenames; Linux is not. Being
 *  lenient here can only widen the candidate set, and ties are resolved by hash
 *  rather than guessed at, so leniency costs nothing. */
function sameName (a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

/** A real move preserves size and mtime exactly — both must be known to count. */
function sameSizeAndMtime (candidate: MoveCandidate, file: IncomingFile): boolean {
  if (candidate.mtimeMs === null || file.mtimeMs === null) return false;
  return candidate.sizeBytes === file.sizeBytes && candidate.mtimeMs === file.mtimeMs;
}

/**
 * Match `file` against tombstoned `candidates`, cheapest signal first.
 *
 * Order matters — a real move preserves size and mtime exactly, so those settle
 * the overwhelming majority of cases without reading a single byte. Hashing is
 * reserved for genuine ambiguity: hashing every added file would cost more than
 * the re-index this whole mechanism exists to avoid.
 *
 *   1. size + mtime + basename all agree  → moved to a new directory
 *   2. size + mtime agree, basename differs → renamed in place
 *   3. contentHash agrees                  → moved, when metadata was inconclusive
 *
 * A tier that produces more than one candidate is reported as `ambiguous`
 * instead of picking one, because guessing would graft one file's history onto
 * another — strictly worse than the re-index we are trying to prevent. The
 * caller answers that by hashing and calling again with `contentHash` set; on
 * that second pass the hash takes precedence over the metadata tiers and every
 * path resolves, so the exchange happens at most once.
 */
export function matchIdentity<C extends MoveCandidate> (
  file: IncomingFile,
  candidates: C[],
): MatchResult<C> {
  if (candidates.length === 0) return { kind: "none" };

  // Once the hash is known it is decisive in the negative: a candidate whose
  // recorded hash differs is provably different bytes, whatever its size and
  // mtime say. Candidates with no hash yet stay in play.
  const pool = file.contentHash
    ? candidates.filter(c => c.contentHash === null || c.contentHash === file.contentHash)
    : candidates;
  if (pool.length === 0) return { kind: "none" };

  // ...and decisive in the positive, so it outranks the metadata tiers when we
  // have paid for it. Prefer a candidate that also kept its name; beyond that
  // the matches are byte-identical and therefore interchangeable.
  if (file.contentHash) {
    const byHash = pool.filter(c => c.contentHash === file.contentHash);
    if (byHash.length > 0) {
      const named = byHash.find(c => sameName(c.basename, file.basename));
      return { kind: "matched", candidate: named ?? byHash[0]!, via: "content-hash" };
    }
    // Every candidate predates hashing. Fall through to the metadata tiers.
  }

  /**
   * Settle one tier. A tie is only reported as `ambiguous` while a hash could
   * still break it — on the second pass we already know the bytes agree as far
   * as anything can tell, so picking one both terminates and is harmless.
   */
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

  // Metadata found nothing. This is exactly where hashing earns its cost, so
  // ask for one — but only if some candidate has a hash to compare against.
  if (!file.contentHash && pool.some(c => c.contentHash !== null)) {
    return { kind: "ambiguous", candidates: pool };
  }

  return { kind: "none" };
}
