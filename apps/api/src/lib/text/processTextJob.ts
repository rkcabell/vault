// File: apps/api/src/lib/text/processTextJob.ts
import type { S3Client } from "@aws-sdk/client-s3";
import { extractPdfText, type PdfTextPage } from "@/services/pdf/extractPdfText.js";
import { ocrWithOcrmypdf } from "@/services/ocr/ocrWithOcrmypdf.js";
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

export type ProcessTextJobDeps = {
  getObjectBuffer?: typeof getObjectBuffer;
  ocrWithOcrmypdf?: typeof ocrWithOcrmypdf;
};

export async function processTextJob (
  args: {
    s3: S3Client;
    bucket: string;
    key: string;
    mimeType?: string | null;
    forceOcr?: boolean;
    language?: string | null;
    rotation?: string | null;
  },
  deps: ProcessTextJobDeps = {},
): Promise<ProcessTextResult> {
  const { s3, bucket, key, mimeType, forceOcr, language, rotation } = args;
  const getBuffer = deps.getObjectBuffer ?? getObjectBuffer;
  const runOcrmypdf = deps.ocrWithOcrmypdf ?? ocrWithOcrmypdf;

  const isPdf = mimeType ? mimeType.toLowerCase().includes("pdf") : false;

  // Native extraction path
  if (isPdf && !forceOcr) {
    const pdfBuffer = await getBuffer(s3, bucket, key);
    if (!pdfBuffer) throw new TextJobError("SOURCE_NOT_READY", "Source object not ready");

    const extracted = await extractPdfText(pdfBuffer);

    return {
      textSource: "NATIVE",
      rawText: extracted.fullText,
      pages: extracted.pages,
      needsOcr: extracted.needsOcr,
    };
  }

  const sourceBuffer = await getBuffer(s3, bucket, key);
  if (!sourceBuffer) throw new TextJobError("SOURCE_NOT_READY", "Source object not ready");

  // OCR path for images and PDFs (forced) using OCRmyPDF, then extract text from OCR'd PDF.
  const { ocrPdf } = await runOcrmypdf({
    input: sourceBuffer,
    mimeType,
    language: language ?? undefined,
    rotation: rotation ?? undefined,
  });

  let extracted;
  try {
    extracted = await extractPdfText(ocrPdf);
  } catch {
    // One retry for OCR text extraction only.
    extracted = await extractPdfText(ocrPdf);
  }

  return {
    textSource: "OCR",
    rawText: extracted.fullText,
    pages: extracted.pages,
    needsOcr: false,
  };
}
