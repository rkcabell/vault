"use client";
export default function SearchInput({ value, onChange }: { value: string; onChange: (v: string)=>void }) {
  return (
    <input
      className="w-full max-w-lg rounded border px-3 py-2"
      placeholder="Search by title or OCR textâ€¦"
      value={value}
      onChange={(e)=>onChange(e.target.value)}
    />
  );
}