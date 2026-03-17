import type { TextSource } from "./types";

export function formatBytes(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) return "N/A";
  if (value === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const formatted = size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}

export async function readErrorMessage(response: Response, fallback: string) {
  try {
    const data = await response.json();
    if (data?.error || data?.message) return data.error || data.message;
  } catch {
    // ignore
  }
  return `${fallback} (${response.status})`;
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeTextSource(value?: string | null): TextSource {
  if (value === "OCR") return "OCR";
  if (value === "NATIVE") return "NATIVE";
  return "UNKNOWN";
}

export function parseSearchTerms(value: string) {
  const terms = value
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);

  const unique: string[] = [];
  for (const term of terms) {
    if (!unique.includes(term)) unique.push(term);
    if (unique.length >= 6) break;
  }

  return unique;
}

export function containsAnyTerm(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
}
