// File: app/layout.tsx
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./../styles/globals.css";
import { Providers } from "@/components/providers";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Vault",
  description: "Personal document & photo vault",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.className} min-h-screen bg-bg text-neutral-900 dark:bg-bg-dark dark:text-neutral-100 antialiased`}
      >
        <Providers>
          <div className="mx-auto max-w-7xl p-4">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
