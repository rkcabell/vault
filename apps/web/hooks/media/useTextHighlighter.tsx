'use client'

import { useCallback, useMemo, type ReactNode } from 'react'
import type { SearchMatch, TextSegment } from '@/lib/media/types'
import { escapeRegExp } from '@/lib/media/utils'
import { cn } from '@/lib/utils'

export function useTextHighlighter (args: {
  highlightTerms: string[]
}) {
  const { highlightTerms } = args

  const uniqueHighlightTerms = useMemo(
    () => Array.from(new Set(highlightTerms.filter(Boolean))),
    [highlightTerms]
  )

  const renderSegment = useCallback(
    (
      segment: TextSegment,
      segmentMatches: SearchMatch[],
      activeMatchId: string | null
    ) => {
      const segmentText = segment.text ?? ''
      if (!segmentText) return null

      const matches: Array<{
        start: number
        end: number
        type: 'search' | 'highlight'
        matchId?: string
      }> = []

      for (const match of segmentMatches) {
        matches.push({
          start: match.start,
          end: match.end,
          type: 'search',
          matchId: match.matchId
        })
      }

      for (const term of uniqueHighlightTerms) {
        const pattern = new RegExp(escapeRegExp(term), 'gi')
        let match: RegExpExecArray | null = null
        while ((match = pattern.exec(segmentText)) !== null) {
          matches.push({
            start: match.index,
            end: match.index + match[0].length,
            type: 'highlight'
          })
        }
      }

      if (matches.length === 0) {
        return segmentText
      }

      matches.sort((a, b) => {
        if (a.start === b.start) {
          if (a.type === b.type) return a.end - b.end
          return a.type === 'search' ? -1 : 1
        }
        return a.start - b.start
      })

      const segmentNodes: ReactNode[] = []
      let cursor = 0

      for (const match of matches) {
        if (match.start < cursor) continue
        if (match.start > cursor) {
          segmentNodes.push(segmentText.slice(cursor, match.start))
        }

        const isSearch = match.type === 'search'
        const isActive = isSearch && match.matchId === activeMatchId
        const searchMatchId = isSearch ? match.matchId : undefined
        const activeMatchAttr = isSearch && isActive ? 'true' : undefined

        segmentNodes.push(
          <mark
            key={`${segment.segmentId}-${match.start}-${match.end}-${match.type}`}
            data-segment-id={segment.segmentId}
            data-offset={match.start}
            data-length={match.end - match.start}
            data-match-id={searchMatchId}
            data-active-match={activeMatchAttr}
            className={cn(
              'rounded px-0.5',
              isSearch ? 'bg-amber-200 text-foreground' : 'bg-yellow-200/80 text-foreground'
            )}
          >
            {segmentText.slice(match.start, match.end)}
          </mark>
        )
        cursor = match.end
      }

      if (cursor < segmentText.length) {
        segmentNodes.push(segmentText.slice(cursor))
      }

      return segmentNodes
    },
    [uniqueHighlightTerms]
  )

  return { renderSegment }
}
