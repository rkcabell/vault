// File: app/(protected)/library/page.tsx
"use client";

import { Suspense } from "react";
import LibraryPageInner from "./LibraryPageInner";

export default function MediaLibraryPage() {
  return (
    <Suspense fallback={null}>
      <LibraryPageInner />
    </Suspense>
  );
}
