"use client";

import { useEffect, useState, type ReactNode } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/utils";

type PanelCardProps = {
  title: string;
  storageKey: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  contentClassName?: string;
};

export function PanelCard({
  title,
  storageKey,
  children,
  defaultOpen = true,
  className,
  contentClassName,
}: PanelCardProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(storageKey);
    if (stored !== null) {
      setIsOpen(stored === "true");
    }
    setIsReady(true);
  }, [storageKey]);

  useEffect(() => {
    if (!isReady) return;
    window.localStorage.setItem(storageKey, String(isOpen));
  }, [isOpen, isReady, storageKey]);

  return (
    <Collapsible.Root open={isOpen} onOpenChange={setIsOpen}>
      <Card className={cn("min-w-0", className)}>
        <Collapsible.Trigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 px-6 py-5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <span className="text-lg font-semibold leading-tight">{title}</span>
            <ChevronRight
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform duration-200",
                isOpen ? "rotate-90" : "rotate-0"
              )}
            />
          </button>
        </Collapsible.Trigger>
        <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <div className={cn("px-6 pb-6 pt-1", contentClassName)}>
            {children}
          </div>
        </Collapsible.Content>
      </Card>
    </Collapsible.Root>
  );
}
