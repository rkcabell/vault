import { EXT_MIME } from "./mimeFromExtension.js";
import { extOf } from "./extensions.js";

/**
 * Built-in "non-content" filters for in-place indexing. Pointing a scan at a
 * directory that contains a dev/build tree (node_modules, compiled binaries,
 * build output, source code) otherwise creates tens of thousands of useless
 * Media rows — each spawning a thumbnail + OCR job. These filters let the
 * indexer skip that bloat by default while keeping documents, images, media,
 * and content-text.
 *
 * Allowlist semantics: isNonContentFile passes only extensions Vault can
 * actually process (the same set as mimeFromExtension.ts). Unknown extensions
 * and extension-less files are filtered rather than indexed. Gated by the
 * `indexSkipNonContent` preference (default on) and stacks on top of the
 * user's own `indexBlacklistExtensions` and `indexExcludeFolders`.
 */

/** Dependency / build / tooling directories skipped wholesale (matched by basename). */
export const BUILD_DIR_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "bower_components",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "vcpkg",
  "lib",
  "bin",
  "pkgs",
  "site-packages",
  ".next",
  ".nuxt",
  ".cache",
  "cache",
  "caches",
  "temp",
  "tmp",
  ".temp",
  ".tmp",
  "__pycache__",
  ".venv",
  "venv",
  ".gradle",
  ".idea",
  ".vscode",
  "coverage",
  ".terraform",
  ".pytest_cache",
  ".mypy_cache",
  // Package-manager caches / install trees (the "slag" a PM spawns)
  ".npm", // npm cache
  ".yarn", // Yarn (Berry) cache + state
  ".pnpm-store", // pnpm content-addressable store
  ".cargo", // Rust crates cache
  ".bundle", // Ruby Bundler
  ".nuget", // .NET NuGet packages
  ".tox", // Python tox envs
  ".eggs", // setuptools build eggs
  "wheelhouse", // pip wheel output
  "conda-meta", // conda environment metadata
]);

/**
 * Directory *suffixes* (lowercase) that mark a dependency/metadata dir. These
 * carry a variable prefix (the package name) so an exact-name set can't match
 * them — e.g. `pytest-8.3.2.dist-info`, `requests.egg-info`. The pip/wheel
 * `.dist-info` dirs are where METADATA / WHEEL / RECORD / INSTALLER live.
 */
export const BUILD_DIR_SUFFIXES: readonly string[] = [".dist-info", ".egg-info", ".egg"];

/**
 * Allowlist of extensions Vault can index and process
 * mimeFromExtension.ts sync to handle new formats as they are added.
 * Any extension absent from this set is treated as non-content and skipped.
 */
const CONTENT_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(EXT_MIME));

/**
 * Skip important directories such as OS/system files, disk metadata, trash/recycle bin.
 * TODO: Missing important skips?
 */
export const JUNK_DIR_NAMES: ReadonlySet<string> = new Set([
  "$recycle.bin",
  "system volume information",
  ".trash",
  ".trashes",
]);

/**
 * Exact filenames (lowercase) that are OS metadata, never content:
 * Windows thumbnail caches / folder settings, macOS Finder droppings.
 * TODO: Missing important skips?
 */
export const JUNK_FILE_NAMES: ReadonlySet<string> = new Set([
  "thumbs.db",
  "desktop.ini",
  ".ds_store",
  ".localized",
  "icon\r",
]);

/** Extensions (lowercase, no dot) of transient/partial files — temp, in-progress
 *  downloads, editor swap files. Always junk regardless of skipNonContent.
 * TODO: Missing important skips?
 * */
export const JUNK_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "tmp",
  "part",
  "partial",
  "crdownload",
  "swp",
  "swo",
]);

/** Checks if directory is a build-file directory */
export function isBuildDir (name: string): boolean {
  const lower = name.toLowerCase();
  if (BUILD_DIR_NAMES.has(lower)) return true;
  return BUILD_DIR_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

/**
 * Runs file's extension against Vault's known-content allowlist.
 */
export function isNonContentFile (name: string): boolean {
  return !CONTENT_EXTENSIONS.has(extOf(name));
}

/** Runs directory name against JUNK_DIR_NAMES. */
export function isJunkDir (name: string): boolean {
  return JUNK_DIR_NAMES.has(name.toLowerCase());
}

/**
 * Runs file against JUNK_FILE_NAMES and JUNK_FILE_EXTENSIONS, plus some common OS/editor patterns.
 */
export function isJunkFile (name: string): boolean {
  const lower = name.toLowerCase();
  if (JUNK_FILE_NAMES.has(lower)) return true;
  if (JUNK_FILE_EXTENSIONS.has(extOf(name))) return true;
  if (lower.startsWith("~$")) return true; // Office lock files
  if (lower.startsWith("._")) return true; // macOS AppleDouble resource forks
  if (lower.endsWith("~")) return true; // editor backups (foo.txt~)
  return false;
}
