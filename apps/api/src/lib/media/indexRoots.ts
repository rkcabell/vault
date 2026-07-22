import path from "node:path";

/**
 * In-place indexing reads original files from outside Vault-managed storage.
 * The allowed roots are the security boundary: the per-user list of absolute
 * directories Vault is permitted to walk and read from, stored in preferences
 * (`indexAllowedRoots`, managed via Settings → In-place indexing and the
 * /api/server/index-config route). An empty list disables the feature.
 *
 * These helpers are shared by the API (index route, source-stream route) and
 * the workers, so the allow-list is enforced identically on every access — a
 * stored `sourcePath` is re-validated against current config each time it is
 * read, never trusted just because it once passed.
 */

/** Thrown when a path is not inside any configured allowed root. */
export class PathNotAllowedError extends Error {
  code = "PATH_NOT_ALLOWED";
  constructor (p: string) {
    super(`Path is not within the allowed indexing roots: ${p}`);
    this.name = "PathNotAllowedError";
  }
}

/**
 * Canonical absolute form of a path. On Windows the filesystem is
 * case-insensitive, so `E:/data` and `e:\data` name the same directory but
 * compare unequal as strings — which breaks both the allow-list check and the
 * `(userId, sourcePath)` dedup index. Canonical form: resolved separators plus
 * an uppercased drive letter. (Path *segments* keep their case; containment
 * checks below compare case-insensitively on Windows instead.)
 */
export function canonicalizeAbsPath (p: string): string {
  const resolved = path.resolve(p);
  if (process.platform === "win32" && /^[a-z]:/.test(resolved)) {
    return resolved[0].toUpperCase() + resolved.slice(1);
  }
  return resolved;
}

/** Parse the raw env value into a list of normalized absolute roots. */
export function parseAllowedRoots (raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length > 0 && path.isAbsolute(s))
    .map(canonicalizeAbsPath);
}

/** True if `child` is `parent` itself or sits somewhere beneath it. */
function isWithin (parent: string, child: string): boolean {
  // NTFS is case-insensitive: compare canonically so an allow-list root typed
  // as `E:/Data` still admits a walked path reported as `e:\data\...`.
  const a = process.platform === "win32" ? parent.toLowerCase() : parent;
  const b = process.platform === "win32" ? child.toLowerCase() : child;
  const rel = path.relative(a, b);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** True if `target` resolves to a location inside one of `allowedRoots`. */
export function isUnderAllowedRoot (target: string, allowedRoots: string[]): boolean {
  if (allowedRoots.length === 0) return false;
  const resolved = path.resolve(target);
  return allowedRoots.some(root => isWithin(root, resolved));
}

/**
 * True if `root` and `storagePath` overlap in either direction. Used to reject
 * index roots that sit inside Vault-managed storage (or contain it) — indexing
 * Vault's own blob tree would catalog its thumbnails as documents.
 */
export function overlapsStoragePath (root: string, storagePath: string | undefined | null): boolean {
  if (!storagePath) return false;
  const a = canonicalizeAbsPath(root);
  const b = canonicalizeAbsPath(storagePath);
  return isWithin(a, b) || isWithin(b, a);
}

/** True for an excluded folder itself or anything beneath it. Empty list excludes nothing. */
export function isExcludedFolder (target: string, excludeFolders: string[]): boolean {
  if (excludeFolders.length === 0) return false;
  const resolved = path.resolve(target);
  return excludeFolders.some(folder => isWithin(path.resolve(folder), resolved));
}

/**
 * Assert `target` is inside an allowed root, returning the resolved absolute
 * path. Throws `PathNotAllowedError` otherwise. Guards against `..` traversal
 * and absolute-path escapes the same way `fsAdapter.resolveKeyPath` does.
 */
export function assertUnderAllowedRoot (target: string, allowedRoots: string[]): string {
  if (!isUnderAllowedRoot(target, allowedRoots)) {
    throw new PathNotAllowedError(target);
  }
  return canonicalizeAbsPath(target);
}
