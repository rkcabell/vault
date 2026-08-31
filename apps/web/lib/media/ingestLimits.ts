import { classifyUploadKind, uploadLimitForKind, UPLOAD_LIMIT_LABELS } from "@vault/types";

export {
  PHOTO_UPLOAD_LIMIT_BYTES,
  DOCUMENT_UPLOAD_LIMIT_BYTES,
  HARD_UPLOAD_LIMIT_BYTES,
  UPLOAD_LIMIT_LABELS,
  classifyUploadKind,
  uploadLimitForKind,
  type UploadKind,
} from "@vault/types";

/** Client half of the shared limit policy: checked against `File.size` before sending. */
export function getFileSizeError (file: File): string | null {
  const mimeType = file.type?.trim() || "application/octet-stream";
  const kind = classifyUploadKind(mimeType, file.name);
  const limit = uploadLimitForKind(kind);

  if (file.size > limit) {
    const label = kind === "photo" ? "Photos" : kind === "document" ? "Documents" : "Files";
    return `${label} must be ${UPLOAD_LIMIT_LABELS[kind]} or smaller.`;
  }

  return null;
}
