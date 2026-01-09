//File: apps/web/components/theme-toggle.tsx
"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ThemeToggle({
  lightIcon,
  darkIcon
}: {
  lightIcon?: React.ReactNode;
  darkIcon?: React.ReactNode;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const isDark = resolvedTheme === "dark";
  return (
    <button
      aria-label="Toggle theme"
      className="theme-toggle"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      title="Toggle theme"
    >
      <span className="theme-toggle__icon">{isDark ? lightIcon : darkIcon}</span>
      <span className="theme-toggle__label">{isDark ? "Light" : "Dark"}</span>
    </button>
  );
}
