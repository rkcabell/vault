//File: app/(public)/auth/page.tsx
"use client";

import { Suspense } from "react";
import AuthPageInner from "./AuthPageInner";

export default function AuthPage() {
  return (
    <Suspense fallback={null}>
      <AuthPageInner />
    </Suspense>
  );
}