//File: apps/web/components/ui/logout_button.tsx

import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();

  return (
    <button
      className="rounded-md border px-3 py-2 text-sm"
      onClick={async () => {
        await fetch("/api/auth/logout", {
          method: "POST",
          credentials: "include",
        });

        // Go to login, then force a refresh so middleware + server components re-evaluate cookies
        router.push("/auth");
        router.refresh();
      }}
    >
      Logout
    </button>
  );
}
