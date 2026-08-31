import { app } from '@/lib/app'
import { apiFetch } from '@/lib/apiFetch'
import { readErrorMessage } from './utils'

export type BatchRequeueResult = { queued: number; missing: number }

async function postBatch (
  path: string,
  ids: string[],
  fallback: string
): Promise<BatchRequeueResult> {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ ids })
  })

  if (!res.ok) {
    const message = await readErrorMessage(res, fallback)
    app.log.error('media batch re-queue failed', { path, count: ids.length, error: message })
    throw new Error(message)
  }

  return res.json() as Promise<BatchRequeueResult>
}

export async function regenerateThumbnailsBatch (ids: string[]): Promise<BatchRequeueResult> {
  app.log.info('media batch thumbnail regenerate requested', { count: ids.length })
  return postBatch('/api/media/batch/thumbnail', ids, 'Unable to regenerate thumbnails.')
}

export async function extractTextBatch (ids: string[]): Promise<BatchRequeueResult> {
  app.log.info('media batch text extraction requested', { count: ids.length })
  return postBatch('/api/media/batch/text', ids, 'Unable to extract text.')
}

/** How many scans are parked waiting for OCR, across the whole library. */
export type ScannedBacklogResult = { queued: number; remaining: number }

export async function fetchScannedBacklogCount (): Promise<number> {
  const res = await apiFetch('/api/media/text/scanned/count', { credentials: 'include' })
  if (!res.ok) return 0
  const data = (await res.json()) as { count?: number }
  return data.count ?? 0
}

/**
 * Queue OCR for the deferred-scan backlog. The server caps how much it takes in
 * one call — each job is minutes of a core — and returns what is still waiting,
 * so a very large backlog is drained by pressing again rather than by one
 * request that never returns.
 */
export async function extractAllScannedText (): Promise<ScannedBacklogResult> {
  app.log.info('scanned-backlog text extraction requested')
  const res = await apiFetch('/api/media/batch/text/scanned', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({})
  })

  if (!res.ok) {
    const message = await readErrorMessage(res, 'Unable to start text extraction.')
    app.log.error('scanned-backlog text extraction failed', { error: message })
    throw new Error(message)
  }

  return res.json() as Promise<ScannedBacklogResult>
}
