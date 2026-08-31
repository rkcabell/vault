import { classifyUploadKind, uploadLimitForKind, UPLOAD_LIMIT_LABELS } from "@vault/types";

/**
 * The server's half of the upload size policy it shares with the browser.
 */

export {
  PHOTO_UPLOAD_LIMIT_BYTES,
  DOCUMENT_UPLOAD_LIMIT_BYTES,
  HARD_UPLOAD_LIMIT_BYTES,
  UPLOAD_LIMIT_LABELS,
  classifyUploadKind,
  uploadLimitForKind,
  type UploadKind,
} from "@vault/types";

/**
 * Returns the message for a file that is over its size limit, or null when it
 * fits. Checked against the bytes that arrived, never a claimed Content-Length.
 */
export function getUploadSizeError (args: {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}): string | null {
  const { filename, mimeType, sizeBytes } = args;
  const kind = classifyUploadKind(mimeType, filename);
  const limit = uploadLimitForKind(kind);

  if (sizeBytes > limit) {
    const label = kind === "photo" ? "photos" : kind === "document" ? "documents" : "files";
    return `${filename} exceeds the ${label} limit (${UPLOAD_LIMIT_LABELS[kind]} max).`;
  }

  return null;
}
