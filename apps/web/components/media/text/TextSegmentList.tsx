'use client'

// File: apps/web/components/media/text/TextSegmentList.tsx

import React from 'react'
import type { SearchMatch, TextSegment } from '@/lib/media/types'
import { cn } from '@/lib/utils'

const EMPTY_MATCHES: SearchMatch[] = []

type RenderSegment = (
  segment: TextSegment,
  segmentMatches: SearchMatch[],
  activeMatchId: string | null,
) => React.ReactNode

export type TextSegmentListProps = {
  segments: TextSegment[]
  matchesBySegmentId: Map<number, SearchMatch[]>
  activeMatchId: string | null
  renderSegment: RenderSegment

  // Where the scroll container node should be stored (used for jumping via querySelector/scrollIntoView).
  scrollContainerRef?: React.MutableRefObject<HTMLDivElement | null>

  className?: string
}

export const TextSegmentList = React.forwardRef<HTMLDivElement, TextSegmentListProps>(
  function TextSegmentList(props, forwardedRef) {
    const {
      segments,
      matchesBySegmentId,
      activeMatchId,
      renderSegment,
      scrollContainerRef,
      className,
    } = props

    return (
      <div
        ref={(node) => {
          if (scrollContainerRef) {
            scrollContainerRef.current = node
          }
          if (typeof forwardedRef === 'function') {
            forwardedRef(node)
          } else if (forwardedRef) {
            forwardedRef.current = node
          }
        }}
        className={cn('h-full w-full min-h-0 overflow-y-auto', className)}
      >
        <div className="p-4 whitespace-pre-wrap break-words">
          {segments.map((segment) => (
            <div key={segment.segmentId} className="mb-6">
              {renderSegment(
                segment,
                matchesBySegmentId.get(segment.segmentId) ?? EMPTY_MATCHES,
                activeMatchId,
              )}
            </div>
          ))}
        </div>
      </div>
    )
  },
)

TextSegmentList.displayName = 'TextSegmentList'
