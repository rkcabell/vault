// apps/web/lib/api.ts
import { cookies } from 'next/headers'
import type { MediaDetailResponse, MediaWorkerState } from './media/types'

const API_BASE =
  typeof window === 'undefined'
    ? (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000') + '/api'
    : '/api'

export type MediaListItem = {
  id: string
  title?: string | null
  filename?: string | null
  mimeType?: string | null
  sizeBytes?: number | null
  createdAt?: string
  thumbState?: MediaWorkerState | null
  textState?: MediaWorkerState | null
  tags?: string[]
  thumbnailKey?: string | null
}

async function http<T> (path: string, init?: RequestInit): Promise<T> {
  const isServer = typeof window === 'undefined'

  // IMPORTANT: on the server, fetch() does NOT automatically include browser cookies
  const cookieHeader = isServer ? (await cookies()).toString() : ''

  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(isServer ? { cookie: cookieHeader } : {}),
      ...(init?.headers || {})
    },
    ...init,
    cache: 'no-store'
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `HTTP ${res.status}`)
  }

  const ctype = res.headers.get('content-type') || ''
  if (ctype.includes('application/json')) return res.json() as Promise<T>
  return (await res.text()) as unknown as T
}

export async function searchMedia (
  q: string,
  tags: string[] = []
): Promise<MediaListItem[]> {
  const qs = new URLSearchParams()
  if (q) qs.set('q', q)
  if (tags.length) qs.set('tags', tags.join(','))
  return http<MediaListItem[]>(`/media?${qs.toString()}`)
}

export async function initUpload (
  filename: string,
  mime: string
): Promise<{ id: string; putUrl: string }> {
  return http(`/media`, {
    method: 'POST',
    body: JSON.stringify({ filename, mime })
  })
}

export async function getMediaById (id: string): Promise<MediaDetailResponse> {
  return http<MediaDetailResponse>(`/media/${id}`)
}

export async function getThumbnailUrl (id: string): Promise<string | null> {
  try {
    const r = await http<{ url: string }>(`/media/${id}/thumbnail`)
    return r.url
  } catch {
    return null
  }
}

export async function listMedia (
  opts: { q?: string } = {}
): Promise<MediaListItem[]> {
  const qs = new URLSearchParams()
  if (opts.q) qs.set('q', opts.q)

  const r = await http<{ items: MediaListItem[] }>(`/media?${qs.toString()}`)
  return r.items
}

export async function pollReady (
  id: string,
  attempts = 10,
  ms = 1000
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const res = await getMediaById(id)
    const media = res?.media ?? res
    if (media?.thumbState === 'READY' && media?.textState === 'READY' && media?.thumbnailKey) return
    await new Promise(r => setTimeout(r, ms))
  }
}
