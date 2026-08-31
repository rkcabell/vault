import type { MediaWorkerState, TextSegment, TextSource } from '@/lib/media/types'

/**
 * Maps raw textState + textError (BullMQ failedReason) to a human-readable message.
 * The raw error is shown separately in "View logs/details".
 */
export function classifyTextError (
  textState: MediaWorkerState | null | undefined,
  textError: string | null | undefined,
): string | null {
  const raw = textError ?? ''

  // No error detail means the job was removed (user cancelled) or stall-detected
  if (!raw) {
    return 'Extraction was stopped before it could complete.'
  }

  if (/SOURCE_NOT_READY|Source object not ready/i.test(raw)) {
    return 'The file was not ready for processing. It may still be uploading — try again in a moment.'
  }

  if (/ocrmypdf failed/i.test(raw)) {
    return 'OCR processing failed. The file may be corrupted or in an unsupported format.'
  }

  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|NetworkingError/i.test(raw)) {
    return 'A network error interrupted extraction. Check your connection and try again.'
  }

  if (/Throttl|Rate exceeded|TooManyRequests/i.test(raw)) {
    return 'The server is under load. Please try again in a few minutes.'
  }

  if (/ENOSPC|no space left/i.test(raw)) {
    return 'Extraction failed due to insufficient server disk space. Contact support.'
  }

  if (/ENV_MISSING|MissingEnvError/i.test(raw)) {
    return 'Server configuration error. Please contact support.'
  }

  if (/PdfReadError|Invalid PDF|corrupt|damaged/i.test(raw)) {
    return 'The file could not be read. Try re-uploading it.'
  }

  if (/OCR timed out|TIMEOUT/i.test(raw)) {
    return 'Extraction timed out. The file may be too large or complex — try again, or contact support if this keeps happening.'
  }

  return null
}

export function isPlaceholderText (input: string | TextSegment[]) {
  const textContent = Array.isArray(input) ? getPreviewText(input) : input
  const trimmed = textContent.trim().toUpperCase()
  if (!trimmed) return true
  return trimmed.startsWith('STUB') || trimmed.startsWith('PLACEHOLDER')
}

function getPreviewText (segments: TextSegment[], limit = 200) {
  let preview = ''
  for (const segment of segments) {
    if (preview.length >= limit) break
    preview += segment.text.slice(0, limit - preview.length)
  }
  return preview
}

export function getStatusChip (args: {
  isErrorState: boolean
  isRunning: boolean
  canShowViewer: boolean
  isUnsupported?: boolean
  isQueued?: boolean
}) {
  const { isErrorState, isRunning, canShowViewer, isUnsupported, isQueued } = args
  if (isUnsupported) return { label: 'Not supported', variant: 'secondary' as const }
  if (isErrorState) return { label: 'Failed', variant: 'destructive' as const }
  if (isQueued) return { label: 'Queued', variant: 'secondary' as const }
  if (isRunning) return { label: 'Running', variant: 'secondary' as const }
  if (canShowViewer) return { label: 'Ready', variant: 'default' as const }
  return { label: 'No text', variant: 'secondary' as const }
}

export function formatSourceChipLabel (textSource: TextSource): string | null {
  if (textSource === 'OCR') return 'OCR'
  if (textSource === 'NATIVE') return 'Native'
  return null
}

export function formatLastUpdatedText (textUpdatedAt?: string | null) {
  if (!textUpdatedAt) return null
  const d = new Date(textUpdatedAt)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString()
}

export function getProgressLine (args: {
  textTotalLength: number
}) {
  const { textTotalLength } = args
  if (textTotalLength > 0) {
    return `Showing all text (${textTotalLength.toLocaleString()} characters)`
  }
  return null
}

export function getMatchPositionLabel (activeMatchIndex: number, matchCount: number) {
  return matchCount > 0 ? `${activeMatchIndex + 1} of ${matchCount}` : '0 of 0'
}

export function shouldShowEmptyState (args: {
  isRunning: boolean
  isErrorState: boolean
  textState: string
  hasAnyText: boolean
}) {
  const { isRunning, isErrorState, textState, hasAnyText } = args
  return (
    !isRunning &&
    !isErrorState &&
    (textState === 'empty' || textState === 'idle' || !hasAnyText)
  )
}
