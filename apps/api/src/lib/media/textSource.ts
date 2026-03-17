type InferTextSourceInput = {
  documentTextSource?: string | null;
  mimeType?: string | null;
};

export type TextSource = "OCR" | "NATIVE" | "UNKNOWN";

export function inferTextSource ({ documentTextSource, mimeType }: InferTextSourceInput): TextSource {
  if (documentTextSource === "OCR" || documentTextSource === "NATIVE") {
    return documentTextSource;
  }

  if (mimeType?.startsWith("text/")) {
    return "NATIVE";
  }

  return "UNKNOWN";
}
