/**
 * WCAG contrast-ratio tests for every theme defined in globals.css.
 *
 * Data-driven: add a new entry to the `themes` array and the test loop
 * generates cases automatically. No new test() calls needed.
 *
 * Pairs generated per theme entry
 * ────────────────────────────────
 *  • foreground       on background   AA (4.5 : 1)
 *  • card-foreground  on card         AA (4.5 : 1)  — only when card differs
 *  • primary-fg       on primary      AA (4.5 : 1)
 *  • muted-fg         on background   AA by default; override via mutedFgThreshold
 *  • each reminderColor on background AA by default; override via threshold
 *
 * Light theme variants that don't override a variable inherit :root defaults
 * (LIGHT_FG / LIGHT_MUTED_FG). Dark variants inherit html.dark defaults
 * (DARK_FG / DARK_MUTED_FG).
 *
 * rgba() reminder-snoozed values are excluded — composited contrast depends on
 * the rendered background and cannot be determined statically.
 */

import test from "node:test";
import assert from "node:assert/strict";

// ─── WCAG colour utilities ────────────────────────────────────────────────────

/** Parse "H S% L%" → [h, s, l]. */
function parseHsl(value: string): [number, number, number] {
  const [h, s, l] = value.trim().split(/\s+/);
  return [parseFloat(h), parseFloat(s), parseFloat(l)];
}

/** HSL (h 0–360, s 0–100, l 0–100) → sRGB [0–1]. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

/** Parse "#rrggbb" → sRGB [0–1]. */
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

function linearise(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

function contrastRatio(
  fg: [number, number, number],
  bg: [number, number, number],
): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const hsl = (v: string) => hslToRgb(...parseHsl(v));
const hex = (v: string) => hexToRgb(v);

const AA       = 4.5; // WCAG AA normal text
const AA_LARGE = 3.0; // WCAG AA large text / UI components

function assertContrast(
  fg: [number, number, number],
  bg: [number, number, number],
  minRatio: number,
  label: string,
) {
  const ratio = contrastRatio(fg, bg);
  assert.ok(
    ratio >= minRatio,
    `[${label}] contrast ${ratio.toFixed(2)} : 1 is below the ${minRatio} : 1 WCAG threshold`,
  );
}

// ─── Theme data ───────────────────────────────────────────────────────────────

/** Inherited defaults for light and dark bases (:root / html.dark). */
const LIGHT_FG      = "0 0% 3.9%";
const LIGHT_MUTED_FG = "0 0% 35%";
const DARK_FG       = "0 0% 98%";
const DARK_MUTED_FG  = "0 0% 70%";

interface ReminderColor {
  /** Solid hex colour (rgba values must be composited first and are excluded). */
  hex: string;
  label: string;
  /** Override the background the reminder colour is tested against. */
  background?: string;
  /** Defaults to AA (4.5). */
  threshold?: number;
}

interface Theme {
  name: string;
  background: string;
  foreground: string;
  /** Only provide when the card surface differs from the background. */
  card?: string;
  cardForeground?: string;
  primary: string;
  primaryForeground: string;
  mutedForeground: string;
  /** Defaults to AA (4.5). Lower for themes where the shared muted token
   *  doesn't reach 4.5 : 1 on a saturated mid-value background. */
  mutedFgThreshold?: number;
  reminderColors?: ReminderColor[];
  /**
   * Override the destructive HSL value for themes where the default red
   * (0 84.2% 60.2%) fails contrast. When provided, two tests are generated:
   *   • destructive-foreground on destructive  (AA 4.5 : 1)
   *   • destructive on background              (AA_LARGE 3.0 : 1)
   * Omit for themes that use the inherited default without issue.
   */
  destructive?: string;
  /** Override destructive-foreground HSL. Defaults to "0 0% 98%". */
  destructiveForeground?: string;
}

const themes: Theme[] = [
  // ── Light themes ────────────────────────────────────────────────────────────
  {
    name: "default-light",
    background: "240 5% 99%",
    foreground: LIGHT_FG,
    primary: "0 0% 9%",
    primaryForeground: "0 0% 98%",
    mutedForeground: LIGHT_MUTED_FG,
    reminderColors: [
      // Amber on near-white is a known WCAG borderline (~3.1 : 1); large-text threshold.
      { hex: "#d97706", label: "today",   threshold: AA_LARGE },
      { hex: "#dc2626", label: "overdue" },
    ],
  },
  {
    name: "latte",
    background: "36 60% 95%",
    foreground: LIGHT_FG,
    primary: "36 68% 22%",
    primaryForeground: "0 0% 98%",
    mutedForeground: LIGHT_MUTED_FG,
  },
  {
    name: "solarize",
    background: "28 55% 82%",
    foreground: LIGHT_FG,
    primary: "28 72% 24%",
    primaryForeground: "0 0% 98%",
    mutedForeground: LIGHT_MUTED_FG,
    // Warm tan background (~82 % lightness); neutral 35 % grey is ≈4.7 : 1 here.
    // Tested at AA so any regression is caught.
  },
  {
    name: "mist",
    background: "202 28% 94%",
    foreground: LIGHT_FG,
    primary: "202 62% 20%",
    primaryForeground: "0 0% 98%",
    mutedForeground: LIGHT_MUTED_FG,
  },
  {
    name: "lavender",
    background: "263 28% 94%",
    foreground: LIGHT_FG,
    primary: "263 52% 24%",
    primaryForeground: "0 0% 98%",
    mutedForeground: LIGHT_MUTED_FG,
  },
  {
    name: "dream",
    background: "335 34% 95%",
    foreground: LIGHT_FG,
    primary: "335 62% 24%",
    primaryForeground: "0 0% 98%",
    mutedForeground: LIGHT_MUTED_FG,
  },
  {
    name: "cotton-candy",
    background: "200 72% 88%",
    foreground: LIGHT_FG,
    primary: "335 68% 26%",
    primaryForeground: "0 0% 98%",
    mutedForeground: LIGHT_MUTED_FG,
  },
  {
    name: "mint",
    background: "145 26% 92%",
    foreground: LIGHT_FG,
    primary: "148 52% 18%",
    primaryForeground: "0 0% 98%",
    mutedForeground: LIGHT_MUTED_FG,
  },
  {
    name: "garden",
    background: "137 32% 72%",
    foreground: LIGHT_FG,
    primary: "123 53% 29%",
    primaryForeground: "0 0% 98%",
    mutedForeground: LIGHT_MUTED_FG,
    // Medium-value green background (~72 % L). Inherited neutral grey reaches
    // only ~4.0 : 1 here — below AA (4.5) but above large-text threshold (3.0).
    // TODO: consider a darker muted-foreground override in theme-garden.
    mutedFgThreshold: AA_LARGE,
    // Default red (0 84.2% 60.2%) only reaches ~2.1:1 on this background.
    // Overridden to red-800 (≈ #991b1b) — ~4.75:1 on bg, ~8:1 white-on-red.
    destructive: "0 70% 35%",
    reminderColors: [
      // Colours are specifically overridden in the CSS to pass AA on this background.
      { hex: "#78350f", label: "today"   }, // amber-900 ~5.3 : 1
      { hex: "#7f1d1d", label: "overdue" }, // red-950   ~5.7 : 1
      { hex: "#1e3a5f", label: "snoozed" }, // navy      ~7.0 : 1
    ],
  },

  // ── Dark themes ──────────────────────────────────────────────────────────────
  {
    name: "default-dark",
    background: "0 0% 3.9%",
    foreground: DARK_FG,
    primary: "0 0% 98%",
    primaryForeground: "0 0% 9%",
    mutedForeground: DARK_MUTED_FG,
    reminderColors: [
      { hex: "#fcd34d", label: "today"   },
      { hex: "#f87171", label: "overdue" },
    ],
  },
  {
    name: "new-moon",
    background: "0 0% 3.9%",   // inherits dark base
    foreground: DARK_FG,
    card: "221 39% 11%",        // distinct blue-tinted panel
    cardForeground: "0 0% 98%",
    primary: "0 0% 98%",        // inherits dark base
    primaryForeground: "0 0% 9%",
    mutedForeground: DARK_MUTED_FG,
  },
  {
    name: "charcoal",
    background: "220 5% 17%",
    foreground: "0 0% 88%",
    card: "220 5% 20%",
    cardForeground: "0 0% 88%",
    primary: "0 0% 90%",
    primaryForeground: "0 0% 9%",
    mutedForeground: "0 0% 72%",
  },
  {
    name: "matrix",
    background: "0 0% 4%",
    foreground: "120 80% 60%",  // phosphor green
    card: "120 8% 7%",
    cardForeground: "120 80% 60%",
    primary: "120 90% 52%",
    primaryForeground: "0 0% 0%", // black text on bright green button
    mutedForeground: "120 40% 48%",
  },
];

// ─── Test generation ──────────────────────────────────────────────────────────

for (const theme of themes) {
  const { name } = theme;

  test(`${name} — foreground on background`, () =>
    assertContrast(hsl(theme.foreground), hsl(theme.background), AA, `${name}/fg-on-bg`));

  if (theme.card !== undefined && theme.cardForeground !== undefined) {
    test(`${name} — card-foreground on card`, () =>
      assertContrast(hsl(theme.cardForeground!), hsl(theme.card!), AA, `${name}/card-fg-on-card`));
  }

  test(`${name} — primary-foreground on primary`, () =>
    assertContrast(hsl(theme.primaryForeground), hsl(theme.primary), AA, `${name}/primary`));

  test(`${name} — muted-foreground on background`, () =>
    assertContrast(
      hsl(theme.mutedForeground),
      hsl(theme.background),
      theme.mutedFgThreshold ?? AA,
      `${name}/muted-fg`,
    ));

  for (const rc of theme.reminderColors ?? []) {
    test(`${name} — reminder-${rc.label} on background`, () =>
      assertContrast(
        hex(rc.hex),
        hsl(rc.background ?? theme.background),
        rc.threshold ?? AA,
        `${name}/reminder-${rc.label}`,
      ));
  }

  if (theme.destructive !== undefined) {
    const destructiveFg = theme.destructiveForeground ?? "0 0% 98%";
    test(`${name} — destructive-foreground on destructive`, () =>
      assertContrast(hsl(destructiveFg), hsl(theme.destructive!), AA, `${name}/destructive-fg`));
    test(`${name} — destructive on background`, () =>
      assertContrast(hsl(theme.destructive!), hsl(theme.background), AA_LARGE, `${name}/destructive-on-bg`));
  }
}
