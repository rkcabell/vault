import path from "node:path";

/**
 * Decides which filesystem locations in-place indexing may read from.
 */

/** Signals that a path falls outside every allowed indexing root. */
export class PathNotAllowedError extends Error {
  code = "PATH_NOT_ALLOWED";
  constructor (p: string) {
    super(`Path is not within the allowed indexing roots: ${p}`);
    this.name = "PathNotAllowedError";
  }
}

/**
 * Converts an absolute path to its canonical form. Segment case is preserved.
 * Only the Windows drive letter is normalized, to uppercase.
 */
export function canonicalizeAbsPath (p: string): string {
  const resolved = path.resolve(p);
  if (process.platform === "win32" && /^[a-z]:/.test(resolved)) {
    return resolved[0].toUpperCase() + resolved.slice(1);
  }
  return resolved;
}

/** Parses the raw env value into a list of normalized absolute roots. */
export function parseAllowedRoots (raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length > 0 && path.isAbsolute(s))
    .map(canonicalizeAbsPath);
}

// True if `child` is `parent` itself, or sits somewhere beneath it.
function isWithin (parent: string, child: string): boolean {
  // NTFS compares paths case-insensitively.
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

/** True if `root` and `storagePath` overlap in either direction. */
export function overlapsStoragePath (root: string, storagePath: string | undefined | null): boolean {
  if (!storagePath) return false;
  const a = canonicalizeAbsPath(root);
  const b = canonicalizeAbsPath(storagePath);
  return isWithin(a, b) || isWithin(b, a);
}

/** True if `target` is an excluded folder or sits beneath one. */
export function isExcludedFolder (target: string, excludeFolders: string[]): boolean {
  if (excludeFolders.length === 0) return false;
  const resolved = path.resolve(target);
  return excludeFolders.some(folder => isWithin(path.resolve(folder), resolved));
}

/** Resolves `target`, throwing `PathNotAllowedError` if it's outside `allowedRoots`. */
export function assertUnderAllowedRoot (target: string, allowedRoots: string[]): string {
  if (!isUnderAllowedRoot(target, allowedRoots)) {
    throw new PathNotAllowedError(target);
  }
  return canonicalizeAbsPath(target);
}
