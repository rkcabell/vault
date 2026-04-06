"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Panel,
  Group,
  Separator,
  type GroupImperativeHandle,
} from "react-resizable-panels";

export type { GroupImperativeHandle };

const DESKTOP_QUERY = "(min-width: 1024px)";

export default function MediaDetailSplit({
  left,
  right,
  groupRef,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
  groupRef?: React.Ref<GroupImperativeHandle | null>;
}) {
  const [isDesktop, setIsDesktop] = useState(false);

  // Ref callback: runs synchronously when the Separator mounts, before any pointer
  // event can fire. Patches focus() so the library's programmatic element.focus()
  // call (which enables keyboard resize) doesn't scroll the page.
  const separatorRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const orig = el.focus.bind(el);
    el.focus = (options?: FocusOptions) => orig({ ...options, preventScroll: true });
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia(DESKTOP_QUERY);
    const handleChange = () => setIsDesktop(mediaQuery.matches);
    setIsDesktop(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  if (!isDesktop) {
    return (
      <div className="flex flex-col gap-6">
        {left}
        {right}
      </div>
    );
  }

  return (
    <Group orientation="horizontal" className="w-full" groupRef={groupRef}>
      <Panel id="left" defaultSize={62} minSize={300} className="pr-4">
        {left}
      </Panel>

      <Separator
        elementRef={separatorRef}
        className="relative flex w-2 cursor-col-resize items-stretch justify-center bg-transparent transition-colors hover:bg-muted/40 outline-none select-none"
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => e.preventDefault()}
      >
        <div className="h-full w-px bg-border" />
      </Separator>

      <Panel id="right" defaultSize={38} minSize={215} className="pl-4">
        {right}
      </Panel>
    </Group>
  );
}
