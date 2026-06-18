"use client";

import { useEffect } from "react";
import { usePreferences, type LightTheme, type DarkTheme } from "@/hooks/usePreferences";
import { clearBaseCache } from "@/components/overview/viz/vizUtils";

const LIGHT_THEME_CLASSES: Record<LightTheme, string | null> = {
  default: null,
  latte: "theme-latte",
  sandstone: "theme-sandstone",
  mist: "theme-mist",
  lavender: "theme-lavender",
  dream: "theme-dream",
  "cotton-candy": "theme-cotton-candy",
  mint: "theme-mint",
  garden: "theme-garden",
};

const DARK_THEME_CLASSES: Record<DarkTheme, string | null> = {
  "new-moon": "theme-new-moon",
  matrix: "theme-matrix",
  charcoal: "theme-charcoal",
  solarized: "theme-solarized",
};

const ALL_THEME_CLASSES = [
  "theme-latte", "theme-sandstone",
  "theme-mist", "theme-lavender", "theme-dream", "theme-cotton-candy", "theme-mint", "theme-garden",
  "theme-new-moon", "theme-matrix", "theme-charcoal", "theme-solarized",
];

function hexToHslVar(hex: string): string | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

export function ThemeApplier() {
  const { prefs } = usePreferences();

  useEffect(() => {
    const html = document.documentElement;
    ALL_THEME_CLASSES.forEach(c => html.classList.remove(c));

    const lightClass = LIGHT_THEME_CLASSES[prefs.lightTheme];
    const darkClass = DARK_THEME_CLASSES[prefs.darkTheme];

    if (lightClass) html.classList.add(lightClass);
    if (darkClass) html.classList.add(darkClass);
  }, [prefs.lightTheme, prefs.darkTheme]);

  useEffect(() => {
    const html = document.documentElement;
    const colors = prefs.exploreBucketColors ?? {};
    for (const [bucket, hex] of Object.entries(colors)) {
      const hsl = hexToHslVar(hex);
      if (hsl) html.style.setProperty(`--bucket-${bucket}`, hsl);
    }
    clearBaseCache();
  }, [prefs.exploreBucketColors]);

  return null;
}
