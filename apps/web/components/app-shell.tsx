// File: components/app-shell.tsx
"use client";

import { useState } from "react";
import { Sidebar } from "@/components/navigation/sidebar";
import { TopNav } from "@/components/navigation/top-nav";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="grid min-h-screen grid-rows-[auto_1fr]">
      <TopNav onToggleSidebar={() => setSidebarOpen((x) => !x)} />
      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr]">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <main className="min-h-[calc(100vh-3.5rem)] overflow-auto">{children}</main>
      </div>
    </div>
  );
}
