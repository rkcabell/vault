'use client'

import { useEffect, useRef, useState } from 'react'
import { Card, CardContent } from '@/components/ui/Card'
import { useMediaText } from '@/hooks/media/useMediaText'
import type { MediaDocument, MediaWorkerState } from '@/lib/media/types'
import { TextPanelHeader } from './TextPanelHeader'
import { TextRunningBanner } from './TextRunningBanner'
import { TextQueuedBanner } from './TextQueuedBanner'
import { TextErrorPanel } from './TextErrorPanel'
import { TextEmptyState } from './TextEmptyState'
import { MediaTextContent } from './MediaTextContent'
import { ExtractionControls, ExtractionActionButtons } from './ExtractionControls'
import {
  classifyTextError,
  formatLastUpdatedText,
  formatSourceChipLabel,
  getProgressLine,
  getStatusChip,
  isPlaceholderText,
  shouldShowEmptyState
} from './textPanel-utils'
import { app } from '@/lib/app'

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German'
}

function getLanguageLabel (languageCode: string) {
  return LANGUAGE_LABELS[languageCode] ?? languageCode.toUpperCase()
}

function formatElapsed (ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

export function MediaTextPanel (props: {
  id: string
  textState: MediaWorkerState | null | undefined
  /** Null while PENDING means the row is still in the backlog, not extracting. */
  textQueuedAt?: string | null
  textError?: string | null
  document: MediaDocument | null | undefined
  highlightTerms: string[]
  refreshKey: number
  isDeleting: boolean
  onQueuedOcr: () => void
  onCancelledOcr?: () => void
}) {
  const {
    id,
    textState: mediaTextState,
    textQueuedAt,
    textError,
    document,
    highlightTerms,
    refreshKey,
    isDeleting,
    onQueuedOcr,
    onCancelledOcr
  } = props

  app.log.info('MediaTextPanel render', { mediaId: id })

  const [languageOverride, setLanguageOverride] = useState<string | null>(null)
  const [completedIn, setCompletedIn] = useState<string | null>(null)
  const extractionStartRef = useRef<number | null>(null)

  useEffect(() => {
    setLanguageOverride(null)
    setCompletedIn(null)
    extractionStartRef.current = null
  }, [id])

  const {
    containerRef,
    textState,
    segments,
    textTotalLength,
    textSource,
    isCopying,
    copyMessage,
    copySelected,
    copyFull,
    setCopyMessage
  } = useMediaText({
    textState: mediaTextState,
    document,
    refreshKey
  })

  const isTextReady = textState === 'ready'
  // PENDING spans two situations the backend distinguishes by a stamp: no
  // textQueuedAt means the feeder hasn't dispatched the row and nothing is
  // extracting yet. Reporting that as "in progress" is what made a whole
  // backlog look like it was running at once.
  const isWaitingInQueue = mediaTextState === 'PENDING' && !textQueuedAt
  const isRunning =
    !isWaitingInQueue &&
    (textState === 'pending' || textState === 'loading' || mediaTextState === 'PENDING')
  // UNSUPPORTED is the backend's terminal "won't process" state (wrong type or too
  // large) — the worker never ran, so it's not a failure. Show a neutral "Not supported"
  // chip with the reason instead of the destructive "Failed" badge.
  const isUnsupportedType = mediaTextState === 'UNSUPPORTED'
  const isErrorState = (textState === 'failed' || textState === 'error') && !isUnsupportedType

  useEffect(() => {
    if (isRunning) {
      extractionStartRef.current = Date.now()
      setCompletedIn(null)
    } else if (extractionStartRef.current !== null) {
      const elapsed = Date.now() - extractionStartRef.current
      setCompletedIn(formatElapsed(elapsed))
      app.log.info('Text extraction completed', { mediaId: id, elapsed })
      extractionStartRef.current = null
    }
  }, [isRunning]) // eslint-disable-line react-hooks/exhaustive-deps

  const placeholder = isPlaceholderText(segments)
  const hasAnyText = textTotalLength > 0 && !placeholder
  // Waiting counts as busy here: an empty-state CTA under a "Queued" banner
  // reads as "nothing is going to happen".
  const showEmptyState = shouldShowEmptyState({
    isRunning: isRunning || isWaitingInQueue,
    isErrorState,
    textState,
    hasAnyText,
  })
  const canShowViewer = isTextReady && hasAnyText && !showEmptyState
  const isCopyDisabled =
    !isTextReady || isCopying || textTotalLength === 0 || placeholder

  const statusChip = getStatusChip({ isErrorState, isRunning, canShowViewer, isUnsupported: isUnsupportedType, isQueued: isWaitingInQueue })
  const sourceChipLabel = formatSourceChipLabel(textSource)
  const lastUpdatedText = formatLastUpdatedText(undefined)
  const languageStatus = document?.textLanguageStatus ?? null
  const detectedLanguageLabel = document?.textLanguage ?? null
  const overrideLabel = languageOverride ? getLanguageLabel(languageOverride) : null
  const shouldOverrideLanguage = languageStatus === 'short' && Boolean(overrideLabel)
  const languageLabel = shouldOverrideLanguage ? overrideLabel : detectedLanguageLabel

  const progressLine = getProgressLine({ textTotalLength })
  const errorMessage = isErrorState ? classifyTextError(mediaTextState, textError) : null
  const errorDetail = textError ?? null
  // For UNSUPPORTED items the backend supplies a human reason via textError
  // (e.g. "File too large…", "Text extraction isn't supported for this file type").
  const unsupportedReason = isUnsupportedType
    ? (textError ?? 'Text extraction isn’t supported for this file.')
    : null
  const showShortLanguageNote = hasAnyText && languageStatus === 'short'
  const shortLanguageNote = 'Short sample (<100 characters). Detection may be inaccurate.'

  return (
    <Card>
      <CardContent className='space-y-4'>
        <ExtractionControls
          mediaId={id}
          isRunning={isRunning}
          isDeleting={isDeleting}
          hasAnyText={hasAnyText}
          isUnsupported={isUnsupportedType}
          onQueued={onQueuedOcr}
          onError={setCopyMessage}
          onLanguageApplied={setLanguageOverride}
          onCancelled={onCancelledOcr}
        />

        <TextPanelHeader
          statusChip={statusChip}
          sourceLabel={sourceChipLabel}
          lastUpdatedText={lastUpdatedText}
          showMetadata={canShowViewer}
          languageLabel={languageLabel}
          languageStatus={languageStatus}
          languageOverride={shouldOverrideLanguage}
        />

        {(progressLine || (completedIn && isTextReady)) && (
          <div className='flex flex-wrap items-center gap-2 text-sm text-muted-foreground'>
            {progressLine && (
              <span>
                {progressLine}
                {showShortLanguageNote ? ` \u00b7 ${shortLanguageNote}` : null}
              </span>
            )}
            {completedIn && isTextReady && (
              <span className='text-xs'>Completed in {completedIn}</span>
            )}
          </div>
        )}

        {isWaitingInQueue && (
          <TextQueuedBanner
            mediaId={id}
            onPrioritized={onQueuedOcr}
            onError={setCopyMessage}
          />
        )}

        {isRunning && (
          <TextRunningBanner
            mediaId={id}
            onCancelled={onCancelledOcr}
            onError={setCopyMessage}
          />
        )}

        {isErrorState && (
          <TextErrorPanel
            message={errorMessage}
            detail={errorDetail}
            actions={
              <ExtractionActionButtons
                mediaId={id}
                onQueued={() => {
                  setLanguageOverride(null)
                  onQueuedOcr()
                }}
                onError={setCopyMessage}
                isDeleting={isDeleting}
                primaryLabel='Retry'
                pendingPrimaryLabel='Retrying...'
                primaryVariant='destructive'
              />
            }
          />
        )}

        {isUnsupportedType && (
          <p className='text-sm text-muted-foreground'>{unsupportedReason}</p>
        )}

        {showEmptyState && !isErrorState && !isRunning && !isUnsupportedType && (
          <TextEmptyState
            isDeleting={isDeleting}
          />
        )}

        {canShowViewer && (
          <MediaTextContent
            segments={segments}
            highlightTerms={highlightTerms}
            containerRef={containerRef}
            copyMessage={copyMessage}
            copySelected={copySelected}
            copyFull={copyFull}
            isCopyDisabled={isCopyDisabled}
          />
        )}
      </CardContent>
    </Card>
  )
}
