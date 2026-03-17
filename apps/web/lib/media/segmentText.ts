import type { TextSegment } from './types'

const DEFAULT_SEGMENT_LENGTH = 3500

export function segmentExtractedText (args: {
  rawText: string
  maxLength?: number
}): TextSegment[] {
  const { rawText, maxLength = DEFAULT_SEGMENT_LENGTH } = args
  const text = rawText ?? ''
  if (!text) return []

  const segments: TextSegment[] = []
  let start = 0
  let order = 0

  while (start < text.length) {
    const hardEnd = Math.min(start + maxLength, text.length)
    let end = hardEnd

    if (hardEnd < text.length) {
      const lastWhitespace = findLastWhitespace(text, start, hardEnd)
      if (lastWhitespace > start) {
        end = lastWhitespace + 1
      }
    }

    segments.push({ segmentId: order, order, text: text.slice(start, end) })
    order += 1
    start = end
  }

  return segments
}

function findLastWhitespace (text: string, start: number, end: number) {
  for (let i = end - 1; i > start; i -= 1) {
    if (/\s/.test(text[i])) return i
  }
  return -1
}
