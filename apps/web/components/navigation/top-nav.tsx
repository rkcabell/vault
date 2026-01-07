// File: components/navigation/top-nav.tsx
"use client";

import Link from "next/link";
import { Menu, Moon, Sun, LogOut } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { useRouter } from "next/navigation";

export function TopNav({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const router = useRouter();
  return (
    <header className="sticky top-0 z-50 h-14 border-b border-border bg-white/70 backdrop-blur dark:border-border-dark dark:bg-bg-dark/70">
      <div className="mx-auto flex h-full max-w-screen-2xl items-center gap-3 px-3">
        <button
          aria-label="Open menu"
          className="rounded-md p-2 hover:bg-gray-100 focus:outline-none dark:hover:bg-gray-800 md:hidden"
          onClick={onToggleSidebar}
        >
          <Menu className="h-5 w-5" />
        </button>

        <Link href="/media" className="font-semibold">
          Vault
        </Link>

        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle lightIcon={<Sun className="h-4 w-4" />} darkIcon={<Moon className="h-4 w-4" />} />
          <button
            className="rounded-md border px-2 py-1 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
            onClick={() => {
              // Demo logout: clear cookie and go to /auth
              document.cookie = "access_token=; Path=/; Max-Age=0";
              router.push("/auth");
            }}
          >
            <LogOut className="mr-1 inline h-4 w-4" />
            Logsout
          </button>
        </div>
      </div>
    </header>
  );
}
