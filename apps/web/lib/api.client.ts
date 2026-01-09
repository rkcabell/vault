// apps/web/lib/api.client.ts

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? ''

type InitUploadResp = { id: string; putUrl: string }

export async function initUpload (
  filename: string,
  mimeType: string,
  sizeBytes?: number,
  title?: string
): Promise<InitUploadResp> {
  const res = await fetch(`${API_BASE}/api/media`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename,
      mimeType,
      sizeBytes: sizeBytes ?? 0,
      title: title ?? filename,
      tags: []
    })
  })

  if (!res.ok) {
    throw new Error(`initUpload failed (${res.status})`)
  }

  return res.json()
}

export async function getMedia (id: string) {
  const res = await fetch(`${API_BASE}/api/media/${id}`, {
    method: 'GET',
    credentials: 'include'
  })
  if (!res.ok) throw new Error(`getMedia failed (${res.status})`)
  return res.json()
}

// Poll until status === "READY" (or attempts exhausted)
export async function pollReady (id: string, attempts = 12, delayMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    const item = await getMedia(id)
    if (item?.status === 'READY') return item
    await new Promise(r => setTimeout(r, delayMs))
  }
  return null
}
