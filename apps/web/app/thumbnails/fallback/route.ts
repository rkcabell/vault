import type { NextRequest } from "next/server";

type FallbackKind = "image" | "pdf" | "file";

const FALLBACKS: Record<FallbackKind, { label: string; bg: string; frame: string }> = {
  image: { label: "IMAGE", bg: "#173f5f", frame: "#20639b" },
  pdf: { label: "PDF", bg: "#5b2a2a", frame: "#c44536" },
  file: { label: "FILE", bg: "#2d3142", frame: "#4f5d75" },
};

function toKind(value: string | null): FallbackKind {
  if (value === "image" || value === "pdf" || value === "file") return value;
  return "file";
}

function renderSvg(kind: FallbackKind): string {
  const { label, bg, frame } = FALLBACKS[kind];
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480" role="img" aria-label="${label} thumbnail">
  <rect width="640" height="480" fill="${bg}"/>
  <rect x="48" y="48" width="544" height="384" rx="28" fill="${frame}" opacity="0.85"/>
  <g fill="#f4f4f6" font-family="Arial, Helvetica, sans-serif" text-anchor="middle">
    <text x="320" y="250" font-size="64" font-weight="700">${label}</text>
    <text x="320" y="300" font-size="18" opacity="0.8">Preview unavailable</text>
  </g>
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
