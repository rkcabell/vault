import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function Home() {
  const cookieStore = await cookies();
  const isLoggedIn = Boolean(cookieStore.get("access_token")?.value);

  if (isLoggedIn) redirect("/media");

  return (
    <main style={{ padding: 24 }}>
      <h1>Vault</h1>
      <p>Upload, search, and manage your files.</p>
      <p>
        <Link href="/auth">Sign in</Link>
      </p>
    </main>
  );
}
