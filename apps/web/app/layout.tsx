// File: app/layout.tsx
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Providers } from "@/components/providers";
import "@/styles/globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Vault",
  description: "Personal document & photo vault",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.className} min-h-screen text-foreground antialiased`}
        style={{ backgroundColor: "hsl(var(--page-background))" }}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

