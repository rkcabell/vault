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

// Rough height estimate per segment based on character count.
// Overestimates slightly to avoid cutting off content.
function estimateHeight(segment: TextSegment): number {
  const charsPerLine = 70
  const lineHeightPx = 22
  const lines = Math.ceil((segment.text?.length ?? 0) / charsPerLine)
  // 56px = segment label (~20px) + padding + mb-6 (24px) + buffer
  return Math.max(lines * lineHeightPx, 40) + 56
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

  // Reset cached item sizes when segment list changes
  useEffect(() => {
    listRef.current?.resetAfterIndex(0)
  }, [segments])

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
    return (
      <div style={style} className="whitespace-pre-wrap break-words">
        <div className="px-4 pb-6">
          {renderSegment(
            segment,
            matchesBySegmentId.get(segment.segmentId) ?? EMPTY_MATCHES,
            activeMatchId,
          )}
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
        itemSize={(index) => estimateHeight(segments[index])}
        overscanCount={OVERSCAN}
        className="text-sm leading-relaxed text-foreground"
      >
        {Row}
      </VariableSizeList>
    </div>
  )
})
