"use client";

import { useEffect, useState } from "react";
import {
  Panel,
  Group,
  Separator,
} from "react-resizable-panels";

const DESKTOP_QUERY = "(min-width: 1024px)";

export default function MediaDetailSplit({
  left,
  right,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia(DESKTOP_QUERY);
    const handleChange = () => setIsDesktop(mediaQuery.matches);

    handleChange();

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
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
    <Group orientation="horizontal" className="w-full">
      <Panel defaultSize={62} minSize={30} className="pr-4">
        {left}
      </Panel>

        <Separator className="relative flex w-2 cursor-col-resize items-stretch justify-center bg-transparent transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          <div className="h-full w-px bg-border" />
        </Separator>

      <Panel defaultSize={38} minSize={25} className="pl-4">
        {right}
      </Panel>
    </Group>
  );
}
