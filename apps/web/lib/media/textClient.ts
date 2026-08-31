import { app } from '@/lib/app'
import { apiFetch } from '@/lib/apiFetch'
import { readErrorMessage } from './utils'

type RerunOptions = {
  language?: string
  rotation?: string
  forceOcr?: boolean
}

/** `queued: false` = the server refused the re-run and enqueued nothing; the row
 *  is UNSUPPORTED (wrong type, or plain text over the size cap). */
export type RerunResult = { ok: boolean; queued: boolean }

export async function rerunMediaTextExtraction (
  mediaId: string,
  options: RerunOptions = {}
): Promise<RerunResult> {
  app.log.info('media text rerun requested', { mediaId, options })

  const res = await apiFetch(`/api/media/${mediaId}/text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(options)
  })

  if (!res.ok) {
    const message = await readErrorMessage(res, 'Unable to re-run text extraction.')
    app.log.error('media text rerun failed', { mediaId, error: message })
    throw new Error(message)
  }

  return (await res.json()) as RerunResult
}

export type TextQueuePosition = { position: number; total: number }

/** Null when the item is no longer waiting — it was dispatched or finished. */
export async function getTextQueuePosition (mediaId: string): Promise<TextQueuePosition | null> {
  const res = await apiFetch(`/api/media/${mediaId}/text/queue-position`, {
    credentials: 'include'
  })
  if (!res.ok) return null
  return (await res.json()) as TextQueuePosition
}

/** Tier 1 only. A NEEDS_OCR row's "run it now" is the forced-OCR rerun instead. */
export async function prioritizeMediaText (mediaId: string) {
  app.log.info('media text prioritize requested', { mediaId })

  const res = await apiFetch('/api/media/batch/text/prioritize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ ids: [mediaId] })
  })

  if (!res.ok) {
    const message = await readErrorMessage(res, 'Unable to move this file to the front.')
    app.log.error('media text prioritize failed', { mediaId, error: message })
    throw new Error(message)
  }
}

export async function cancelMediaTextExtraction (mediaId: string) {
  app.log.info('media text cancel requested', { mediaId })

  const res = await apiFetch(`/api/media/${mediaId}/text/cancel`, {
    method: 'POST',
    credentials: 'include'
  })

  if (!res.ok) {
    const message = await readErrorMessage(res, 'Unable to cancel text extraction.')
    app.log.error('media text cancel failed', { mediaId, error: message })
    throw new Error(message)
  }
}
