import path from "node:path";

/**
 * In-place indexing reads original files from outside Vault-managed storage.
 * `INDEX_ALLOWED_ROOTS` is the security boundary: a comma-separated list of
 * absolute directories Vault is permitted to walk and read from. Empty/unset
 * disables the feature entirely.
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
    super(`Path is not within INDEX_ALLOWED_ROOTS: ${p}`);
    this.name = "PathNotAllowedError";
  }
}

/** Parse the raw env value into a list of normalized absolute roots. */
export function parseAllowedRoots (raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length > 0 && path.isAbsolute(s))
    .map(s => path.resolve(s));
}

/** True if `child` is `parent` itself or sits somewhere beneath it. */
function isWithin (parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** True if `target` resolves to a location inside one of `allowedRoots`. */
export function isUnderAllowedRoot (target: string, allowedRoots: string[]): boolean {
  if (allowedRoots.length === 0) return false;
  const resolved = path.resolve(target);
  return allowedRoots.some(root => isWithin(root, resolved));
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
  return path.resolve(target);
}
