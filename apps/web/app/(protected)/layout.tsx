// File: app/(protected)/layout.tsx
import { AppShell } from "@/components/common/AppShell";
import { AuthGuard } from "@/components/common/AuthGuard";

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <AppShell>
        {children}
      </AppShell>
    </AuthGuard>
  );
}
