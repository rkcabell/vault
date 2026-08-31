/**
 * Flattens a file/folder drop into a plain `File[]`.
 *
 * `DataTransfer.files` holds a zero-byte `File` for a directory, so a folder
 * drop has to go through the entries API instead. Ingest posts each file under
 * `file.name` alone, so nesting is discarded here the same way the
 * `webkitdirectory` input already discards it.
 */

const MAX_DEPTH = 16;
export const MAX_DROPPED_FILES = 5000;

export interface DroppedFiles {
  files: File[];
  /** True when the depth or count cap stopped the walk before it finished. */
  truncated: boolean;
}

export function isFileDrag(dataTransfer: DataTransfer | null | undefined): boolean {
  return dataTransfer?.types?.includes("Files") ?? false;
}

function isFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile;
}

function isDirectoryEntry(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
  return entry.isDirectory;
}

function entryFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise(resolve => {
    entry.file(
      file => resolve(file),
      () => resolve(null),
    );
  });
}

/**
 * One `readEntries` call returns at most 100 entries and signals the end of the
 * directory with an empty array — a single call silently truncates anything
 * larger and looks like success.
 */
async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>(resolve => {
      reader.readEntries(
        entries => resolve(entries),
        () => resolve([]),
      );
    });
    if (batch.length === 0) return all;
    all.push(...batch);
    if (all.length > MAX_DROPPED_FILES) return all;
  }
}

export async function readDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedFiles> {
  // `items` is neutered once the drop handler returns, so every entry handle is
  // taken synchronously here and the async walk runs off the collected list.
  const roots: FileSystemEntry[] = [];
  const items = dataTransfer.items;
  if (items) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind !== "file") continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry) roots.push(entry);
    }
  }

  if (roots.length === 0) {
    return { files: Array.from(dataTransfer.files ?? []), truncated: false };
  }

  const files: File[] = [];
  let truncated = false;

  const walk = async (entry: FileSystemEntry, depth: number): Promise<void> => {
    if (files.length >= MAX_DROPPED_FILES) {
      truncated = true;
      return;
    }
    if (isFileEntry(entry)) {
      const file = await entryFile(entry);
      if (file) files.push(file);
      return;
    }
    if (!isDirectoryEntry(entry)) return;
    if (depth >= MAX_DEPTH) {
      truncated = true;
      return;
    }
    for (const child of await readAllEntries(entry.createReader())) {
      await walk(child, depth + 1);
    }
  };

  for (const root of roots) await walk(root, 0);

  return { files, truncated };
}
