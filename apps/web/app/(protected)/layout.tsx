// File: app/(protected)/layout.tsx
import { AppShell } from "@/components/common/AppShell";
import { AuthGuard } from "@/components/common/AuthGuard";
import { IndexProgressProvider } from "@/components/contexts/IndexProgressContext";
import { DeleteProgressProvider } from "@/components/contexts/DeleteProgressContext";
import { DerivativeProgressProvider } from "@/components/contexts/DerivativeProgressContext";

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <IndexProgressProvider>
        <DeleteProgressProvider>
          <DerivativeProgressProvider>
            <AppShell>
              {children}
            </AppShell>
          </DerivativeProgressProvider>
        </DeleteProgressProvider>
      </IndexProgressProvider>
    </AuthGuard>
  );
}
