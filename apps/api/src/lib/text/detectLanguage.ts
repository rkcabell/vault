/**
 * Guesses which language a file's extracted text is written in, for display
 * beside the text.
 */
import { franc } from "franc";

/** How much to trust the guess: a confident result, one made from too little text, or no result at all. */
export type TextLanguageStatus = "ok" | "short" | "error";

export type DetectedLanguage = {
  code: string | null;
  label: string | null;
  status: TextLanguageStatus;
};

// Below this many characters a guess is reported as "short" rather than
// withheld. Only the leading characters up to the maximum are examined, since
// more text does not improve the guess.
const MIN_LANGUAGE_CHARS = 100;
const MAX_LANGUAGE_CHARS = 2000;
const displayNames = new Intl.DisplayNames(["en"], { type: "language" });

/**
 * Returns the language of `rawText`, with an English name for it.
 *
 * Status "error" covers empty text and text the detector could not place, and
 * carries no language code. A caller cannot distinguish those two cases.
 */
export function detectTextLanguage (rawText?: string | null): DetectedLanguage {
  const text = (rawText ?? "").trim();
  if (!text) {
    return { code: null, label: null, status: "error" };
  }

  const isShort = text.length < MIN_LANGUAGE_CHARS;
  const sampleLength = Math.min(text.length, MAX_LANGUAGE_CHARS);
  const sample = text.slice(0, sampleLength);

  try {
    const code = franc(sample);
    if (!code || code === "und") {
      return { code: null, label: null, status: "error" };
    }
    const label = displayNames.of(code) ?? code;
    return { code, label, status: isShort ? "short" : "ok" };
  } catch {
    return { code: null, label: null, status: "error" };
  }
}
