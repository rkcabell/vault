// Web worker for off-main-thread text search.
// Mirrors the logic in apps/web/lib/media/searchSegments.ts

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

self.onmessage = function (e) {
  const { id, segments, query, maxMatches = 1000, previewRadius = 60 } = e.data
  const trimmed = (query || '').trim()

  if (!trimmed) {
    self.postMessage({ id, matches: [], totalMatches: 0 })
    return
  }

  const matches = []
  let totalMatches = 0
  const pattern = new RegExp(escapeRegExp(trimmed), 'gi')

  for (const segment of segments) {
    const text = segment.text ?? ''
    if (!text) continue

    pattern.lastIndex = 0
    let match
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
          previewEnd: previewMatchEnd,
        })
      }
      totalMatches++
    }
  }

  self.postMessage({ id, matches, totalMatches })
}
