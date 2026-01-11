//File: app/(protected)/overview/page.tsx
"use client";

import { Suspense } from "react";
import OverviewPageInner from "./OverviewPageInner";

export default function OverviewPage() {
  return (
    <Suspense fallback={null}>
      <OverviewPageInner />
    </Suspense>
  );
}