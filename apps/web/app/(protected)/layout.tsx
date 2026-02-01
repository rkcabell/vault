// File: app/(protected)/layout.tsx
import { AppShell } from "@/components/common/AppShell";

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell tags={null} savedViews={[]}>
      {children}
    </AppShell>
  );
}
