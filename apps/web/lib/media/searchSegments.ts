import type { SearchMatch, TextSegment } from './types'
import { escapeRegExp } from './utils'

type SearchResult = {
  matches: SearchMatch[]
  totalMatches: number
}

type SearchOptions = {
  maxMatches?: number
  previewRadius?: number
}

const DEFAULT_MAX_MATCHES = 1000
const DEFAULT_PREVIEW_RADIUS = 30

export function searchSegments (
  segments: TextSegment[],
  query: string,
  opts: SearchOptions = {}
): SearchResult {
  const trimmed = query.trim()
  if (!trimmed) return { matches: [], totalMatches: 0 }

  const maxMatches = opts.maxMatches ?? DEFAULT_MAX_MATCHES
  const previewRadius = opts.previewRadius ?? DEFAULT_PREVIEW_RADIUS

  const matches: SearchMatch[] = []
  let totalMatches = 0
  const pattern = new RegExp(escapeRegExp(trimmed), 'gi')

  for (const segment of segments) {
    const text = segment.text ?? ''
    if (!text) continue

    pattern.lastIndex = 0
    let match: RegExpExecArray | null = null
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index
      const end = start + match[0].length
      const previewStart = Math.max(0, start - previewRadius)
      const previewEnd = Math.min(text.length, end + previewRadius)
      const previewText = text.slice(previewStart, previewEnd)
      const previewMatchStart = start - previewStart
      const previewMatchEnd = previewMatchStart + match[0].length

      if (matches.length < maxMatches) {
        matches.push({
          matchId: `${segment.segmentId}:${start}-${end}`,
          segmentId: segment.segmentId,
          start,
          end,
          previewText,
          previewStart: previewMatchStart,
          previewEnd: previewMatchEnd
        })
      }
      totalMatches += 1
    }
  }

  return { matches, totalMatches }
}
