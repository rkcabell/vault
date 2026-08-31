/**
 * Reads the files out of a zip or tar archive one at a time, without writing
 * the whole archive to disk first.
 */
import type { Readable } from "node:stream";
import path from "node:path";

/** One file found inside an archive. `stream` must be read before the next entry is taken. */
export type ArchiveEntry = {
  path: string;
  stream: Readable;
  size?: number;
  mimeType: string;
};

// Archive entries carry no recorded type, so it is worked out from the name.
const EXT_TO_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".json": "application/json",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/x-rar-compressed",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Returns the type for `filename` based on its extension, or the unknown-bytes type. */
export function mimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

/** True if an entry of this type could be shown as the bundle's cover image. */
export function isCoverCandidate(mimeType: string): boolean {
  return (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("video/") ||
    mimeType === "application/pdf"
  );
}

// Yields each file in a zip. Folder entries are discarded, and their contents
// still arrive as entries of their own.
async function* extractZip(stream: Readable): AsyncIterable<ArchiveEntry> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unzipper = (await import("unzipper")) as any;
  const parse = unzipper.Parse({ forceStream: true });
  stream.pipe(parse);

  for await (const entry of parse) {
    const entryPath: string = entry.path as string;
    const type: string = entry.type as string;

    if (type === "Directory" || entryPath.endsWith("/")) {
      entry.autodrain();
      continue;
    }

    const size: number | undefined =
      typeof entry.vars?.uncompressedSize === "number"
        ? entry.vars.uncompressedSize
        : undefined;

    yield {
      path: entryPath,
      stream: entry as Readable,
      size,
      mimeType: mimeFromFilename(entryPath),
    };
  }
}

// Yields each file in a tar, decompressing first when `mimeType` says the tar
// is gzipped.
//
// The tar library reports entries through events rather than as a sequence, so
// they are collected as they arrive and handed on in order.
async function* extractTar(stream: Readable, mimeType: string): AsyncIterable<ArchiveEntry> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tar = (await import("tar")) as any;

  const isGzip = mimeType === "application/gzip" || mimeType === "application/x-gzip";

  const entries: Array<{ entryPath: string; size?: number; entryStream: Readable }> = [];
  let done = false;

  const parser = new tar.Parse({ gzip: isGzip });

  parser.on("entry", (entry: { path: string; size?: number; type?: string }) => {
    const entryPath: string = entry.path;
    const entryType: string = entry.type ?? "File";

    if (entryType === "Directory" || entryPath.endsWith("/")) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (entry as any).resume();
      return;
    }

    entries.push({
      entryPath,
      size: entry.size,
      entryStream: entry as unknown as Readable,
    });
  });

  parser.on("finish", () => { done = true; });
  parser.on("error", () => { done = true; });

  stream.pipe(parser);

  // Entries are given out as they turn up rather than after parsing finishes,
  // so a large archive is not held in memory.
  let idx = 0;
  while (true) {
    if (idx < entries.length) {
      const { entryPath, size, entryStream } = entries[idx++];
      yield {
        path: entryPath,
        stream: entryStream,
        size,
        mimeType: mimeFromFilename(entryPath),
      };
    } else if (done) {
      break;
    } else {
      await new Promise(r => setTimeout(r, 10));
    }
  }
}

/**
 * Yields each file inside `stream`, an archive of the format named by
 * `mimeType`.
 *
 * Raises for a format that cannot be read, which includes rar and 7z.
 */
export async function* extractArchive(
  stream: Readable,
  mimeType: string,
): AsyncIterable<ArchiveEntry> {
  const lower = mimeType.toLowerCase();

  if (lower === "application/zip" || lower === "application/x-zip-compressed") {
    yield* extractZip(stream);
  } else if (
    lower === "application/x-tar" ||
    lower === "application/gzip" ||
    lower === "application/x-gzip" ||
    lower === "application/x-bzip2"
  ) {
    yield* extractTar(stream, lower);
  } else {
    throw new Error(`Unsupported archive format: ${mimeType}`);
  }
}
