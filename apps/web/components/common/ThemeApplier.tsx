"use client";

import { useEffect } from "react";
import { usePreferences, type LightTheme, type DarkTheme } from "@/hooks/usePreferences";

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

  return null;
}
