"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Bar order follows the order the cards appear on the page. */
export const SETTINGS_CHAPTERS = [
  { id: "general", label: "General" },
  { id: "storage", label: "Storage" },
  { id: "index", label: "Indexing" },
  { id: "metadata", label: "Metadata" },
  { id: "duplicates", label: "Duplicates" },
  { id: "explore", label: "Explore" },
  { id: "tags", label: "Tags" },
] as const;

const LAST_ID = SETTINGS_CHAPTERS[SETTINGS_CHAPTERS.length - 1].id;
const SETTLE_MS = 120;

export function SettingsChapters () {
  const barRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState<string>(SETTINGS_CHAPTERS[0].id);

  // A clicked chapter holds the highlight until its scroll stops; otherwise
  // every chapter it passes lights up in turn.
  const pinnedRef = useRef<string | null>(null);
  const restingRef = useRef(false);
  const settleRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Scrolling happens on AppShell's <main>; window scroll stays 0 here.
  const scrollParent = () => barRef.current?.closest("main") ?? null;

  // Sections clear the sticky bar by its measured height; a hardcoded offset
  // drifts the moment the bar's height changes.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const apply = () => {
      document.documentElement.style.setProperty("--settings-chapter-offset", `${bar.offsetHeight + 12}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  // Reads positions on every scroll. An IntersectionObserver scores only the
  // entries that changed, which skips a card short enough to share the band
  // with a taller neighbour — Duplicates, sitting between two.
  const computeActive = useCallback((): string | null => {
    const root = scrollParent();
    const bar = barRef.current;
    if (!root || !bar) return null;

    // The bottom of the scroll wins outright: a short final card stops above
    // the line, leaving its chapter unreachable.
    const scrollable = root.scrollHeight - root.clientHeight;
    if (scrollable > 4 && root.scrollTop >= scrollable - 2) return LAST_ID;

    const line = bar.getBoundingClientRect().bottom + 1;
    let best: string | null = null;
    let bestTop = -Infinity;
    for (const { id } of SETTINGS_CHAPTERS) {
      const el = document.getElementById(id);
      if (!el) continue;
      const top = el.getBoundingClientRect().top;
      if (top <= line && top > bestTop) { best = id; bestTop = top; }
    }
    return best ?? SETTINGS_CHAPTERS[0].id;
  }, []);

  const pin = useCallback((id: string) => {
    pinnedRef.current = id;
    restingRef.current = false;
    setActive(id);
  }, []);

  useEffect(() => {
    const root = scrollParent();
    if (!root) return;

    let frame = 0;

    // A pin that settles on another chapter is held until the reader scrolls:
    // near the page bottom the clicked section stops above the line.
    const onSettle = () => {
      if (!pinnedRef.current) return;
      if (computeActive() === pinnedRef.current) pinnedRef.current = null;
      else restingRef.current = true;
    };

    const scheduleSettle = () => {
      clearTimeout(settleRef.current);
      settleRef.current = setTimeout(onSettle, SETTLE_MS);
    };

    const update = () => {
      if (pinnedRef.current) {
        if (!restingRef.current) { scheduleSettle(); return; }
        pinnedRef.current = null;
        restingRef.current = false;
      }
      const next = computeActive();
      if (next) setActive(next);
      scheduleSettle();
    };

    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; update(); });
    };

    update();
    root.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);

    // Cards fetch their own state, so the page grows under the reader and the
    // chapter at the line changes with no scroll at all.
    const content = barRef.current?.parentElement;
    const resize = content ? new ResizeObserver(onScroll) : null;
    if (content) resize?.observe(content);

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settleRef.current);
      root.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      resize?.disconnect();
    };
  }, [computeActive]);

  const goTo = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    pin(id);
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    // Focus as well as scroll, or a keyboard user lands nowhere.
    el.focus({ preventScroll: true });
    window.history.pushState(null, "", `#${id}`);
  }, [pin]);

  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id || !SETTINGS_CHAPTERS.some(c => c.id === id)) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    el.focus({ preventScroll: true });
    pin(id);
  }, [pin]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail || rail.scrollWidth <= rail.clientWidth) return;
    const chip = rail.querySelector<HTMLElement>('[aria-current="true"]');
    if (!chip) return;
    rail.scrollTo({ left: chip.offsetLeft - (rail.clientWidth - chip.offsetWidth) / 2, behavior: "smooth" });
  }, [active]);

  return (
    <nav
      ref={barRef}
      aria-label="Settings sections"
      className="sticky top-0 z-20 -mx-6 -mt-2 bg-page px-6 py-2"
    >
      <ul
        ref={railRef}
        className="mx-auto flex w-fit max-w-full gap-1 overflow-x-auto rounded-full border border-border/70 bg-muted/40 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {SETTINGS_CHAPTERS.map(({ id, label }) => (
          <li key={id}>
            <a
              href={`#${id}`}
              onClick={e => { e.preventDefault(); goTo(id); }}
              aria-current={active === id ? "true" : undefined}
              className={cn(
                "block whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active === id
                  ? "bg-[var(--chapter-active-bg)] text-foreground shadow-sm ring-1 ring-[var(--chapter-active-border)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Anchor target for one chapter. `tabIndex` makes it focusable by goTo. */
export function SettingsSection ({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      tabIndex={-1}
      style={{ scrollMarginTop: "var(--settings-chapter-offset, 4rem)" }}
      className={cn("focus:outline-none", className)}
    >
      {children}
    </section>
  );
}
