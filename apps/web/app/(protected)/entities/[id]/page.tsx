export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <div className="p-6">/entities/{id} — Entity view placeholder</div>;
}
