export default async function Page({ params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  return <div className="p-6">/tags/{tag} — Media filtered by tag</div>;
}
