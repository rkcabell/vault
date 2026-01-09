//File: apps/web/components/providers.tsx
"use client";

import { ThemeProvider } from "next-themes";
import { AuthProvider } from '@/components/contexts/AuthContext';
import { UploadProvider } from '@/components/contexts/UploadContext';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <AuthProvider>
        <UploadProvider>
          {children}
          </UploadProvider>
        </AuthProvider>
    </ThemeProvider>
  );
}
