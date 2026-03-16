// apps/web/lib/api.ts
import { cookies } from 'next/headers'
import type { MediaDetailResponse, MediaListItem, MediaListResponse, DownloadResponse, BundleListItem, BundleDetail, BundlesListResponse } from '@vault/types'

const API_BASE =
  typeof window === 'undefined'
    ? (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000') + '/api'
    : '/api'

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
  const r = await http<MediaListResponse>(`/media?${qs.toString()}`)
  return r.items
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

export async function finalizeUpload (id: string): Promise<void> {
  await http(`/media/${id}/finalize`, {
    method: 'POST'
  })
}

export async function getThumbnailUrl (id: string): Promise<string | null> {
  try {
    const r = await http<DownloadResponse>(`/media/${id}/thumbnail`)
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

export async function listBundles (): Promise<BundleListItem[]> {
  const r = await http<BundlesListResponse>('/bundles')
  return r.bundles
}

export async function getBundleById (id: string): Promise<BundleDetail> {
  const r = await http<{ bundle: BundleDetail }>(`/bundles/${id}`)
  return r.bundle
}

export async function pollReady (
  id: string,
  attempts = 10,
  ms = 1000
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const res = await getMediaById(id)
    const media = res.media ?? undefined
    if (
      media?.thumbState === 'READY' &&
      media?.textState === 'READY' &&
      media?.thumbnailKey
    )
      return
    await new Promise(r => setTimeout(r, ms))
  }
}
