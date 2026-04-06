'use client'

/**
 * Virtual-scrolling alternative to TextSegmentList using react-window.
 * Renders only the segments currently visible in the viewport.
 *
 * To revert to the non-virtual TextSegmentList, set USE_VIRTUAL_SCROLL = false
 * in MediaTextContent.tsx — this file can be left as-is.
 */

import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { VariableSizeList } from 'react-window'
import type { SearchMatch, TextSegment } from '@/lib/media/types'
import { cn } from '@/lib/utils'

const EMPTY_MATCHES: SearchMatch[] = []
const OVERSCAN = 3

// Collapse visual whitespace for display purposes.
// 1. Strip trailing spaces/tabs per line so whitespace-only lines become empty
//    lines, letting the \n{3,} rule catch them.
// 2. Collapse runs of 3+ newlines (including previously-whitespace-only lines)
//    down to a single blank line.
// Only applied for display — original text is preserved for search offset accuracy.
function collapseWhitespace(text: string): string {
  return text
    .replace(/[ \t]+$/gm, '')   // strip trailing horizontal whitespace per line
    .replace(/\n{3,}/g, '\n\n') // collapse 3+ consecutive newlines to one blank line
    .trim()                      // remove leading/trailing blank lines at segment boundaries
}

// Height estimate based on actual line count (explicit newlines + wrapping).
function estimateHeightFromText(text: string): number {
  const charsPerLine = 80
  const lineHeightPx = 23
  const lines = text.split('\n').reduce((total, line) => {
    return total + Math.max(1, Math.ceil(line.length / charsPerLine))
  }, 0)
  // 28px = pb-6 bottom padding (24px) + 4px rounding buffer.
  // No top padding and no label are rendered in the Row, so 48px was incorrect.
  return Math.max(lines * lineHeightPx, 40) + 28
}

function estimateHeight(segment: TextSegment, hasMatches: boolean): number {
  // When a segment has matches we render the original text (offset accuracy).
  // When no matches we render collapsed text. Use the same text for estimation
  // so the row height matches what is actually rendered.
  const text = hasMatches
    ? segment.text ?? ''
    : collapseWhitespace(segment.text ?? '')
  return estimateHeightFromText(text)
}

type RenderSegment = (
  segment: TextSegment,
  segmentMatches: SearchMatch[],
  activeMatchId: string | null,
) => React.ReactNode

export type VirtualTextSegmentListHandle = {
  scrollToSegment: (index: number) => void
}

export type VirtualTextSegmentListProps = {
  segments: TextSegment[]
  matchesBySegmentId: Map<number, SearchMatch[]>
  activeMatchId: string | null
  renderSegment: RenderSegment
  scrollContainerRef?: React.MutableRefObject<HTMLDivElement | null>
  className?: string
}

export const VirtualTextSegmentList = forwardRef<
  VirtualTextSegmentListHandle,
  VirtualTextSegmentListProps
>(function VirtualTextSegmentList(props, handle) {
  const {
    segments,
    matchesBySegmentId,
    activeMatchId,
    renderSegment,
    scrollContainerRef,
    className,
  } = props

  const listRef = useRef<VariableSizeList>(null)
  const [containerHeight, setContainerHeight] = useState(300)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Measure the available height so VariableSizeList fills the panel
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      setContainerHeight(entry.contentRect.height)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Reset cached item sizes when segment list or match state changes.
  // matchesBySegmentId changes which text (original vs collapsed) is rendered,
  // so sizes must be recalculated to prevent row overlap.
  useEffect(() => {
    listRef.current?.resetAfterIndex(0)
  }, [segments, matchesBySegmentId])

  useImperativeHandle(handle, () => ({
    scrollToSegment: (index: number) => {
      listRef.current?.scrollToItem(index, 'start')
    },
  }))

  const Row = ({
    index,
    style,
  }: {
    index: number
    style: React.CSSProperties
  }) => {
    const segment = segments[index]
    if (!segment) return null
    const segmentMatches = matchesBySegmentId.get(segment.segmentId) ?? EMPTY_MATCHES
    // Use collapsed text for display when there are no in-page search matches.
    // When search matches exist we must use the original text to preserve offset accuracy.
    const displaySegment =
      segmentMatches.length === 0 && segment.text
        ? { ...segment, text: collapseWhitespace(segment.text) }
        : segment
    return (
      <div style={style} className="whitespace-pre-wrap break-words">
        <div className="px-4 pb-6">
          {renderSegment(displaySegment, segmentMatches, activeMatchId)}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={wrapperRef}
      className={cn('h-full w-full min-h-0', className)}
    >
      <VariableSizeList
        ref={listRef}
        outerRef={(el: HTMLDivElement | null) => {
          if (scrollContainerRef) scrollContainerRef.current = el
        }}
        height={containerHeight}
        width="100%"
        itemCount={segments.length}
        itemSize={(index) => {
          const segment = segments[index]
          return estimateHeight(segment, matchesBySegmentId.has(segment.segmentId))
        }}
        overscanCount={OVERSCAN}
        className="vault-scrollbar text-sm leading-relaxed text-foreground"
      >
        {Row}
      </VariableSizeList>
    </div>
  )
})
