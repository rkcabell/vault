"use client";
import { initUpload, pollReady } from "@/lib/api-client";

import { useRef, useState } from "react";

export function UploadDialog({ onUploaded }: { onUploaded: ()=>void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function doUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const contentType = file.type || "application/octet-stream";
      const title = file.name.replace(/\.[^/.]+$/, "");
      const { id, putUrl } = await initUpload(file.name, contentType, file.size, title);
      // Same-origin proxy uploads (filesystem backend) need the auth cookie;
      // absolute presigned MinIO URLs must not carry credentials.
      const isProxyUpload = putUrl.startsWith("/");
      const res = await fetch(putUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: file,
        ...(isProxyUpload ? { credentials: "include" as const } : {}),
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status}).`);
      // optimistic ping; optional polling for READY
      await pollReady(id, 12, 1000);
      onUploaded();
      setOpen(false);
      fileRef.current!.value = "";
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button className="rounded border px-3 py-2" onClick={()=>setOpen(true)}>Upload</button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50">
          <div className="w-full max-w-md rounded bg-white p-4">
            <h2 className="mb-3 text-lg font-medium">Upload</h2>
            <input type="file" ref={fileRef} className="mb-3 w-full" />
            <div className="flex justify-end gap-2">
              <button className="rounded border px-3 py-2" onClick={()=>setOpen(false)} disabled={busy}>Cancel</button>
              <button className="rounded bg-black px-3 py-2 text-white disabled:opacity-50" onClick={doUpload} disabled={busy}>
                {busy ? "Uploadingâ€¦" : "Upload"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
