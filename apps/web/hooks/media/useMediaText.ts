'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  MediaDocument,
  MediaWorkerState,
  TextSegment,
  TextSource
} from '@/lib/media/types'
import { normalizeTextSource } from '@/lib/media/utils'
import { segmentExtractedText } from '@/lib/media/segmentText'

type TextState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'pending'
  | 'failed'

export function useMediaText (args: {
  textState: MediaWorkerState | null | undefined
  refreshKey: number
  document: MediaDocument | null | undefined
}) {
  const { textState: mediaTextState, refreshKey, document } = args

  const containerRef = useRef<HTMLDivElement | null>(null)

  const [textState, setTextState] = useState<TextState>('idle')
  const [segments, setSegments] = useState<TextSegment[]>([])
  const [textTotalLength, setTextTotalLength] = useState(0)
  const [textSource, setTextSource] = useState<TextSource>('UNKNOWN')
  const [textErrorMessage, setTextErrorMessage] = useState<string | null>(null)

  const [isCopying, setIsCopying] = useState(false)
  const [copyMessage, setCopyMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!copyMessage) return
    const t = window.setTimeout(() => setCopyMessage(null), 1500)
    return () => window.clearTimeout(t)
  }, [copyMessage])

  useEffect(() => {
    // gate on text state
    if (mediaTextState === 'ERROR' || mediaTextState === 'FAILED') {
      setTextState('failed')
      setSegments([])
      setTextTotalLength(0)
      setTextSource('UNKNOWN')
      setTextErrorMessage(null)
      return
    }

    if (mediaTextState === 'PENDING') {
      setTextState('pending')
      setSegments([])
      setTextTotalLength(0)
      setTextSource('UNKNOWN')
      setTextErrorMessage(null)
      return
    }

    // If we don't know status yet, don't spam requests
    if (!mediaTextState) {
      setTextState('idle')
      return
    }

    setTextState('loading')
    setTextErrorMessage(null)

    const rawText = document?.rawText ?? ''
    const allSegments =
      document?.segments && document.segments.length > 0
        ? [...document.segments].sort((a, b) => a.order - b.order)
        : segmentExtractedText({ rawText })
    const totalLength =
      allSegments.length > 0
        ? allSegments.reduce((total, segment) => total + segment.text.length, 0)
        : document?.textTotalLength ?? rawText.length
    const source = normalizeTextSource(document?.textSource)

    setSegments(allSegments)
    setTextTotalLength(totalLength)
    setTextSource(source)
    setTextState(totalLength === 0 ? 'empty' : 'ready')
  }, [
    mediaTextState,
    refreshKey,
    document?.rawText,
    document?.segments,
    document?.textSource,
    document?.textTotalLength
  ])

  const textSourceLabel = useMemo(() => {
    if (textSource === 'OCR') return 'OCR text'
    if (textSource === 'NATIVE') return 'Native text'
    return 'Unknown source'
  }, [textSource])

  const getFullText = () => {
    if (!segments.length) return ''
    return segments.map(segment => segment.text).join('')
  }

  const copySelected = async (fallbackText?: string) => {
    if (isCopying) return
    if (!navigator.clipboard) {
      setCopyMessage('Copy failed.')
      return
    }

    const selection = window.getSelection()
    const selectedText = selection?.toString() ?? ''
    if (!selectedText.trim()) {
      if (fallbackText?.trim()) {
        setIsCopying(true)
        try {
          await navigator.clipboard.writeText(fallbackText.trim())
          setCopyMessage('Copied!')
        } catch {
          setCopyMessage('Copy failed.')
        } finally {
          setIsCopying(false)
        }
        return
      }
      setCopyMessage('No text selected')
      return
    }

    const container = containerRef.current
    if (
      !container ||
      !selection?.anchorNode ||
      !selection?.focusNode ||
      !container.contains(selection.anchorNode) ||
      !container.contains(selection.focusNode)
    ) {
      setCopyMessage('No text selected')
      return
    }

    setIsCopying(true)
    try {
      await navigator.clipboard.writeText(selectedText)
      setCopyMessage('Copied!')
    } catch {
      setCopyMessage('Copy failed.')
    } finally {
      setIsCopying(false)
    }
  }

  const copyFull = async () => {
    if (isCopying) return
    if (!navigator.clipboard) {
      setCopyMessage('Copy failed.')
      return
    }
    if (textTotalLength === 0 || textState === 'empty') {
      setCopyMessage('No text to copy')
      return
    }

    setIsCopying(true)
    try {
      const fullText = getFullText()
      if (!fullText.trim()) {
        setCopyMessage('No text to copy')
        return
      }
      await navigator.clipboard.writeText(fullText)
      setCopyMessage('Copied!')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Copy failed.'
      setCopyMessage(message)
    } finally {
      setIsCopying(false)
    }
  }

  return {
    containerRef,
    textState,
    segments,
    textTotalLength,
    textSource,
    textSourceLabel,
    textErrorMessage,
    isCopying,
    copyMessage,
    copySelected,
    copyFull,
    setCopyMessage
  }
}
