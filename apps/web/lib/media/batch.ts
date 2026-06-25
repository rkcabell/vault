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
