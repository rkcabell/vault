"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/contexts/AuthContext";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/auth");
    }
  }, [status, router]);

  // Render children immediately while auth is loading so the page's data fetch
  // runs in parallel with /api/init instead of waiting for it to complete first.
  // fetchMedia handles 401 by redirecting to /auth if the token is invalid.
  if (status === "unauthenticated") return null;
  return <>{children}</>;
}
