// app/(public)/shared/[token]/page.tsx
export default async function SharedTokenPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="text-xl font-semibold">Shared view</h1>
      <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
        Token:{" "}
        <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-gray-800">
          {token}
        </code>
      </p>
    </main>
  );
}
