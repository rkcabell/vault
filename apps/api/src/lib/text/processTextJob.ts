// File: apps/api/src/lib/text/processTextJob.ts
import type { S3Client } from "@aws-sdk/client-s3";
import { extractPdfText, type PdfTextPage } from "@/services/pdf/extractPdfText.js";
import { getObjectBuffer } from "../../adapters/s3/getObjectBuffer.js";

export type TextSource = "NATIVE" | "OCR";
export type TextJobErrorCode = "SOURCE_NOT_READY";

export class TextJobError extends Error {
  code: TextJobErrorCode;

  constructor (code: TextJobErrorCode, message?: string) {
    super(message ?? code);
    this.name = "TextJobError";
    this.code = code;
  }
}

export type ProcessTextResult = {
  textSource: TextSource;
  rawText: string;
  pages: PdfTextPage[] | null;
  needsOcr: boolean;
};

export async function processTextJob (args: {
  s3: S3Client;
  bucket: string;
  key: string;
  mimeType?: string | null;
  forceOcr?: boolean;
}): Promise<ProcessTextResult> {
  const { s3, bucket, key, mimeType, forceOcr } = args;

  const isPdf = mimeType?.includes("pdf");

  // Native extraction path
  if (isPdf && !forceOcr) {
    const pdfBuffer = await getObjectBuffer(s3, bucket, key);
    if (!pdfBuffer) throw new TextJobError("SOURCE_NOT_READY", "Source object not ready");

    const extracted = await extractPdfText(pdfBuffer);

    return {
      textSource: "NATIVE",
      rawText: extracted.fullText,
      pages: extracted.pages,
      needsOcr: extracted.needsOcr,
    };
  }

  // OCR not performed here; signal that OCR is needed.
  return {
    textSource: "OCR",
    rawText: "STUB: File processed at ${new Date().toISOString()}",
    pages: null,
    needsOcr: true,
  };
}
