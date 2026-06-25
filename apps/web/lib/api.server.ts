// apps/web/lib/api.ts
import { cookies } from 'next/headers'
import type { MediaDetailResponse, MediaListItem, MediaListResponse, MediaStorageItem, MediaCategoryBreakdown, DownloadResponse, BundleListItem, BundleDetail, BundlesListResponse, RemindersSummary, ReminderOverviewRow } from '@vault/types'

const API_BASE =
  typeof window === 'undefined'
    ? (process.env.API_BASE_URL ?? 'http://127.0.0.1:8000') + '/api'
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

export async function listMediaSizes (): Promise<MediaStorageItem[]> {
  const r = await http<{ items: MediaStorageItem[] }>('/media/storage')
  return r.items
}

export async function fetchCategoryBreakdown (): Promise<MediaCategoryBreakdown> {
  try {
    return await http<MediaCategoryBreakdown>('/media/storage/categories')
  } catch {
    return { categories: [], totalFiles: 0, totalBytes: 0 }
  }
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

export interface WorkerQueueCounts {
  waiting: number
  active: number
  delayed: number
  failed: number
}

export interface WorkerCounts {
  ocr:   { active: boolean; count: number; counts: WorkerQueueCounts }
  thumb: { active: boolean; count: number; counts: WorkerQueueCounts }
}

export interface MediaStats {
  totalDocs: number
  storageBytes: number
  typeBreakdown: Array<{ mimeType: string; count: number }>
}

export interface InitResponse {
  user: { id: string; email: string; name: string | null; username: string | null; avatarUrl: string | null } | null
  preferences: Record<string, unknown>
  tags: Array<{ name: string; count: number; color: string | null }>
  bundles: BundleListItem[]
  remindersSummary: RemindersSummary
  overviewReminders: { items: ReminderOverviewRow[] }
  mediaStats: MediaStats
}

export async function fetchInit (): Promise<InitResponse | null> {
  try {
    return await http<InitResponse>('/init')
  } catch {
    return null
  }
}

export async function fetchMediaStats (): Promise<MediaStats | null> {
  try {
    return await http<MediaStats>('/media/stats')
  } catch {
    return null
  }
}

export async function fetchWorkerCounts (): Promise<WorkerCounts | null> {
  try {
    return await http<WorkerCounts>('/server/workers')
  } catch {
    return null
  }
}
