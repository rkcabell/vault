import { inflateRawSync } from "node:zlib";
import type { OfficeMetadata } from "../types.js";

const MAX_ZIP_ENTRIES = 2000;
const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 5 * 1024 * 1024;

export function extractOfficeMetadata (buffer: Buffer): OfficeMetadata | null {
  try {
    const entries = readZipEntries(buffer);
    if (!entries.length) return null;

    const entryMap = new Map(entries.map(entry => [entry.filename, entry]));
    const core = readZipEntry(buffer, entryMap.get("docProps/core.xml") ?? null);
    const app = readZipEntry(buffer, entryMap.get("docProps/app.xml") ?? null);

    if (!core && !app) return null;

    const metadata: OfficeMetadata = {};

    if (core) {
      const xml = core.toString("utf8");
      metadata.lastModifiedBy = readXmlTag(xml, "lastModifiedBy");
      metadata.revision = parseNumber(readXmlTag(xml, "revision"));
      metadata.language = readXmlTag(xml, "language");
    }

    if (app) {
      const xml = app.toString("utf8");
      metadata.application = readXmlTag(xml, "Application");
      metadata.appVersion = readXmlTag(xml, "AppVersion");
    }

    if (entryMap.has("word/comments.xml")) {
      metadata.hasComments = true;
    }

    const settings = readZipEntry(buffer, entryMap.get("word/settings.xml") ?? null);
    if (settings) {
      const xml = settings.toString("utf8");
      if (xml.includes("<w:trackRevisions")) {
        metadata.hasTrackedChanges = true;
      }
    }

    return Object.values(metadata).some(value => value !== undefined && value !== null)
      ? metadata
      : null;
  } catch {
    return null;
  }
}

type ZipEntry = {
  filename: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

function readZipEntries (buffer: Buffer): ZipEntry[] {
  const signature = 0x06054b50;
  const maxComment = 65535;
  const minOffset = Math.max(0, buffer.length - 22 - maxComment);
  let eocdOffset = -1;

  for (let i = buffer.length - 22; i >= minOffset; i -= 1) {
    if (buffer.readUInt32LE(i) === signature) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) return [];

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (totalEntries > MAX_ZIP_ENTRIES) return [];

  const entries: ZipEntry[] = [];
  let cursor = centralDirOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const compression = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const filenameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);

    const filenameStart = cursor + 46;
    const filenameEnd = filenameStart + filenameLen;
    const filename = buffer.toString("utf8", filenameStart, filenameEnd);

    entries.push({
      filename,
      compression,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    cursor = filenameEnd + extraLen + commentLen;
  }

  return entries;
}

function readZipEntry (buffer: Buffer, entry: ZipEntry | null): Buffer | null {
  if (!entry) return null;
  if (entry.uncompressedSize > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) return null;
  if (buffer.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) return null;

  const filenameLen = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLen = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + filenameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart < 0 || dataEnd > buffer.length) return null;
  const payload = buffer.slice(dataStart, dataEnd);

  if (entry.compression === 0) return payload;
  if (entry.compression === 8) {
    try {
      const inflated = inflateRawSync(payload);
      if (inflated.length > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) return null;
      return inflated;
    } catch {
      return null;
    }
  }

  return null;
}

function readXmlTag (xml: string, tagName: string): string | null {
  const pattern = new RegExp(`<(?:\\w+:)?${tagName}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tagName}>`, "i");
  const match = xml.match(pattern);
  if (!match) return null;
  return decodeXml(match[1]?.trim() ?? "");
}

function decodeXml (value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function parseNumber (value?: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
