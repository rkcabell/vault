export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <div className="p-6">/albums/{id} — Album view placeholder</div>;
}
