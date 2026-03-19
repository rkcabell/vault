import type { NextRequest } from "next/server";

type FallbackKind = "image" | "pdf" | "file" | "audio" | "document" | "archive";

const FALLBACKS: Record<FallbackKind, { label: string; bg: string; frame: string; iconPaths?: string }> = {
  image:    { label: "IMAGE",    bg: "#173f5f", frame: "#20639b" },
  pdf:      { label: "PDF",      bg: "#5b2a2a", frame: "#c44536" },
  file:     { label: "FILE",     bg: "#2d3142", frame: "#4f5d75" },
  audio: {
    label: "AUDIO",
    bg: "#1a2a1a",
    frame: "#2d5a2d",
    iconPaths: `<path d="M9 18V5l12-2v13" stroke="#f4f4f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="6" cy="18" r="3" stroke="#f4f4f6" stroke-width="2" fill="none"/><circle cx="18" cy="16" r="3" stroke="#f4f4f6" stroke-width="2" fill="none"/>`,
  },
  document: {
    label: "DOCUMENT",
    bg: "#1a1a2e",
    frame: "#2d2d5a",
    iconPaths: `<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" stroke="#f4f4f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><polyline points="14 2 14 8 20 8" stroke="#f4f4f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><line x1="16" y1="13" x2="8" y2="13" stroke="#f4f4f6" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="17" x2="8" y2="17" stroke="#f4f4f6" stroke-width="2" stroke-linecap="round"/>`,
  },
  archive: {
    label: "ARCHIVE",
    bg: "#2a1a0a",
    frame: "#5a3a1a",
    iconPaths: `<rect width="20" height="5" x="2" y="3" rx="1" stroke="#f4f4f6" stroke-width="2" fill="none"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" stroke="#f4f4f6" stroke-width="2" fill="none"/><path d="M10 12h4" stroke="#f4f4f6" stroke-width="2" stroke-linecap="round"/>`,
  },
};

function toKind(value: string | null): FallbackKind {
  if (
    value === "image" || value === "pdf" || value === "file" ||
    value === "audio" || value === "document" || value === "archive"
  ) return value;
  return "file";
}

function renderSvg(kind: FallbackKind): string {
  const { label, bg, frame, iconPaths } = FALLBACKS[kind];

  const iconLayer = iconPaths
    ? `<g transform="translate(248, 108) scale(6)">${iconPaths}</g>`
    : `<text x="320" y="250" font-size="64" font-weight="700" fill="#f4f4f6" font-family="Arial, Helvetica, sans-serif" text-anchor="middle">${label}</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480" role="img" aria-label="${label} thumbnail">
  <rect width="640" height="480" fill="${bg}"/>
  <rect x="48" y="48" width="544" height="384" rx="28" fill="${frame}" opacity="0.85"/>
  ${iconLayer}
  <text x="320" y="420" font-size="18" fill="#f4f4f6" font-family="Arial, Helvetica, sans-serif" text-anchor="middle" opacity="0.8">Preview unavailable</text>
</svg>`;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const kind = toKind(url.searchParams.get("kind"));
  const svg = renderSvg(kind);

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
