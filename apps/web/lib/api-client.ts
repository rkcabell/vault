// apps/web/lib/api-client.ts

import { apiFetch } from './apiFetch'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? ''

export async function getMedia (id: string) {
  const res = await apiFetch(`${API_BASE}/api/media/${id}`, {
    method: 'GET',
    credentials: 'include'
  })
  if (!res.ok) throw new Error(`getMedia failed (${res.status})`)
  return res.json()
}

export async function unpackMedia (id: string): Promise<{ bundleId: string }> {
  const res = await apiFetch(`${API_BASE}/api/media/${id}/unpack`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(data?.error ?? `unpackMedia failed (${res.status})`)
  }
  return res.json()
}

export function exportBundleUrl (id: string): string {
  return `${API_BASE}/api/bundles/${id}/export`
}

// Poll until both thumb/text states settle (or attempts exhausted). A field is
// "settled" once it leaves PENDING — READY, FAILED, ERROR, or UNSUPPORTED are all
// terminal, so non-processable items don't waste the full attempt budget.
export async function pollReady (id: string, attempts = 12, delayMs = 1000) {
  const settled = (s: string | null | undefined) => s != null && s !== 'PENDING'
  for (let i = 0; i < attempts; i++) {
    const item = await getMedia(id)
    const media = item?.media ?? item
    if (settled(media?.thumbState) && settled(media?.textState)) return item
    await new Promise(r => setTimeout(r, delayMs))
  }
  return null
}
