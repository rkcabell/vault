/**
 * Works out where an item's text came from, so the detail page can say so.
 */

type InferTextSourceInput = {
  documentTextSource?: string | null;
  mimeType?: string | null;
};

export type TextSource = "OCR" | "NATIVE" | "UNKNOWN";

/**
 * Returns how the text was obtained. A value recorded on the document wins. A
 * plain-text file without one counts as NATIVE, since reading it is not
 * extraction.
 */
export function inferTextSource ({ documentTextSource, mimeType }: InferTextSourceInput): TextSource {
  if (documentTextSource === "OCR" || documentTextSource === "NATIVE") {
    return documentTextSource;
  }

  if (mimeType?.startsWith("text/")) {
    return "NATIVE";
  }

  return "UNKNOWN";
}
