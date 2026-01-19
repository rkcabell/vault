import { franc } from "franc";

export type TextLanguageStatus = "ok" | "short" | "error";

export type DetectedLanguage = {
  code: string | null;
  label: string | null;
  status: TextLanguageStatus;
};

const MIN_LANGUAGE_CHARS = 100;
const MAX_LANGUAGE_CHARS = 2000;
const displayNames = new Intl.DisplayNames(["en"], { type: "language" });

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
