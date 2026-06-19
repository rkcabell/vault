// apps/web/lib/api-client.ts

import { apiFetch } from './apiFetch'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? ''

type InitUploadResp = { id: string; putUrl: string }

export async function initUpload (
  filename: string,
  mimeType: string,
  sizeBytes?: number,
  title?: string,
  autoTagOnUpload?: boolean,
): Promise<InitUploadResp> {
  const res = await apiFetch(`${API_BASE}/api/media`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename,
      mimeType,
      sizeBytes: sizeBytes ?? 0,
      title: title ?? filename,
      tags: [],
      ...(autoTagOnUpload !== undefined ? { autoTagOnUpload } : {}),
    })
  })

  if (!res.ok) {
    throw new Error(`initUpload failed (${res.status})`)
  }

  const data = await res.json()
  const putUrl = data?.putUrl ?? data?.uploadUrl
  if (!data?.id || !putUrl) {
    throw new Error('initUpload response missing putUrl')
  }
  return { id: data.id, putUrl }
}

export async function getMedia (id: string) {
  const res = await apiFetch(`${API_BASE}/api/media/${id}`, {
    method: 'GET',
    credentials: 'include'
  })
  if (!res.ok) throw new Error(`getMedia failed (${res.status})`)
  return res.json()
}

export async function finalizeUpload (id: string) {
  const res = await apiFetch(`${API_BASE}/api/media/${id}/finalize`, {
    method: 'POST',
    credentials: 'include'
  })
  if (!res.ok) throw new Error(`finalizeUpload failed (${res.status})`)
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

// Poll until thumb/text states are READY (or attempts exhausted)
export async function pollReady (id: string, attempts = 12, delayMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    const item = await getMedia(id)
    const media = item?.media ?? item
    if (media?.thumbState === 'READY' && media?.textState === 'READY') return item
    await new Promise(r => setTimeout(r, delayMs))
  }
  return null
}
