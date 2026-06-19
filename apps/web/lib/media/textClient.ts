import { app } from '@/lib/app'
import { apiFetch } from '@/lib/apiFetch'
import { readErrorMessage } from './utils'

type RerunOptions = {
  language?: string
  rotation?: string
  forceOcr?: boolean
}

export async function rerunMediaTextExtraction (mediaId: string, options: RerunOptions = {}) {
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
