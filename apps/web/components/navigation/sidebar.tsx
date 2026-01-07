// File: components/navigation/sidebar.tsx
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useEffect } from "react";
import type { UrlObject } from "url";
import type { LucideIcon } from "lucide-react";
import { FolderOpen, Image as ImageIcon, Bell, Tag, User, Home } from "lucide-react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

type LinkItemProps = {
  href: Route | UrlObject;
  label: string;
  icon: LucideIcon;
  pathname: string;
};

function NavLinkItem({ href, label, icon: Icon, pathname }: LinkItemProps) {
  const hrefPath =
    typeof href === "string"
      ? href
      : (href.pathname ?? (typeof href.toString === "function" ? href.toString() : "")); // safe fallback

  const active = typeof hrefPath === "string" && pathname.startsWith(hrefPath);

  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800",
        active && "bg-gray-100 font-medium dark:bg-gray-800"
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </Link>
  );
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  // Close when route changes (on mobile)
  React.useEffect(() => {
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  // Use NavLinkItem in your desktop/mobile renders, e.g.:
  // <NavLinkItem href={"/"} label="Home" icon={Home} pathname={pathname} />
  // <NavLinkItem href={"/media" as Route} label="Media" icon={ImageIcon} pathname={pathname} />
  // <NavLinkItem href={"/tags" as Route} label="Tags" icon={Tag} pathname={pathname} />
  // <NavLinkItem href={"/alerts" as Route} label="Alerts" icon={Bell} pathname={pathname} />
  // <NavLinkItem href={"/profile" as Route} label="Profile" icon={User} pathname={pathname} />
  // <NavLinkItem href={"/folders" as Route} label="Folders" icon={FolderOpen} pathname={pathname} />

  return (
    <>
      {/* Desktop */}
      <aside className="hidden h-[calc(100vh-3.5rem)] border-r border-border bg-white p-3 dark:border-border-dark dark:bg-card-dark md:block">
        <nav className="space-y-1">
          <NavLinkItem href={"/media"} label="Media" icon={ImageIcon} pathname={pathname} />
          <NavLinkItem href={"/albums"} label="Albums" icon={FolderOpen} pathname={pathname} />
          <NavLinkItem href={"/entities"} label="Entities" icon={User} pathname={pathname} />
          <NavLinkItem href={"/tags"} label="Tags" icon={Tag} pathname={pathname} />
          <NavLinkItem href={"/reminders"} label="Reminders" icon={Bell} pathname={pathname} />
          <NavLinkItem href={"/overview"} label="Overview" icon={Home} pathname={pathname} />
        </nav>

        <div className="mt-6 text-xs text-gray-500 dark:text-gray-400">
          <p>Saved Views</p>
          <div className="mt-2 space-y-1">
            <NavLinkItem
              href={{ pathname: "/media", query: { saved: "recent" } }}
              label="Recent uploads"
              icon={ImageIcon}
              pathname={pathname}
            />
            <NavLinkItem
              href={{ pathname: "/media", query: { saved: "expiring" } }}
              label="Expiring soon"
              icon={Bell}
              pathname={pathname}
            />
          </div>
        </div>
      </aside>

      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          role="button"
          aria-label="Close sidebar"
          onClick={onClose}
        />
      )}

      <aside
        className={cn(
          "fixed z-50 w-72 origin-left border-r border-border bg-white p-3 transition-transform dark:border-border-dark dark:bg-card-dark md:hidden",
          open ? "translate-x-0" : "-translate-x-full"
        )}
        style={{ top: 56, bottom: 0 }} // 56px = top-nav height
      >+
        <nav className="space-y-1">
          <NavLinkItem href={"/media"} label="Media" icon={ImageIcon} pathname={pathname} />
          <NavLinkItem href={"/albums"} label="Albums" icon={FolderOpen} pathname={pathname} />
          <NavLinkItem href={"/entities"} label="Entities" icon={User} pathname={pathname} />
          <NavLinkItem href={"/tags"} label="Tags" icon={Tag} pathname={pathname} />
          <NavLinkItem href={"/reminders"} label="Reminders" icon={Bell} pathname={pathname} />
        </nav>
      </aside>
    </>
  )
};
