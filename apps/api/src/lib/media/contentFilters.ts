import { EXT_MIME } from "./mimeFromExtension.js";
import { extOf } from "./extensions.js";

/**
 * Decides which files and directories in-place indexing skips by default.
 * Pointing a scan at a directory holding a build tree would otherwise create
 * tens of thousands of rows for source files and compiled output, each with its
 * own thumbnail and text job.
 *
 * The file test is an allow-list: only the extensions Vault can process pass,
 * and an unknown or missing extension is skipped. The `indexSkipNonContent`
 * preference gates all of it, on top of the user's own blacklist and excluded
 * folders.
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
  // Package-manager caches and install trees.
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
 * Directory suffixes that mark a dependency or metadata directory. Each carries
 * the package name as a prefix, so an exact-name set cannot match them:
 * `pytest-8.3.2.dist-info`, `requests.egg-info`.
 */
export const BUILD_DIR_SUFFIXES: readonly string[] = [".dist-info", ".egg-info", ".egg"];

/**
 * The extensions Vault can index, kept in step with mimeFromExtension.ts. An
 * extension absent from this set counts as non-content and is skipped. Exported
 * so the settings screen can show the user what gets indexed.
 */
export const CONTENT_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(EXT_MIME));

/**
 * Operating-system and disk-metadata directories, and trash folders. Exact names
 * only: Linux's per-user `.Trash-1000` needs a prefix test this set cannot
 * express, so {@link isJunkDir} does that one.
 */
export const JUNK_DIR_NAMES: ReadonlySet<string> = new Set([
  "$recycle.bin",
  "recycler",
  "system volume information",
  "lost+found",
  ".trash",
  ".trashes",
  "__macosx",
  ".appledouble",
  ".spotlight-v100",
  ".fseventsd",
  ".documentrevisions-v100",
  ".temporaryitems",
  ".dropbox.cache",
]);

/**
 * Exact filenames (lowercase) that are OS metadata, never content:
 * Windows thumbnail caches / folder settings, macOS Finder droppings.
 */
export const JUNK_FILE_NAMES: ReadonlySet<string> = new Set([
  "thumbs.db",
  "ehthumbs.db",
  "ehthumbs_vista.db",
  "desktop.ini",
  ".directory",
  ".ds_store",
  ".localized",
  ".apdisk",
  ".volumeicon.icns",
  "icon\r",
]);

/** Extensions (lowercase, no dot) of transient/partial files — temp, in-progress
 *  downloads, editor swap files. Always junk regardless of skipNonContent. */
export const JUNK_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "tmp",
  "temp",
  "part",
  "partial",
  "crdownload",
  "crswap",
  "download",
  "opdownload",
  "driveupload",
  "drivedownload",
  "swp",
  "swo",
  "swn",
]);

/** True when the directory holds dependencies or build output. */
export function isBuildDir (name: string): boolean {
  const lower = name.toLowerCase();
  if (BUILD_DIR_NAMES.has(lower)) return true;
  return BUILD_DIR_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

/** True when the file's extension is not one Vault can process. */
export function isNonContentFile (name: string): boolean {
  return !CONTENT_EXTENSIONS.has(extOf(name));
}

/** True when the directory is operating-system metadata or a trash folder. */
export function isJunkDir (name: string): boolean {
  const lower = name.toLowerCase();
  if (JUNK_DIR_NAMES.has(lower)) return true;
  return lower.startsWith(".trash-"); // per-uid Linux trash (.Trash-1000)
}

/**
 * True when the file is operating-system metadata, an editor backup, or a
 * partly-downloaded file.
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
