'use client'

import { useCallback, useState } from 'react'

/**
 * Minimal clipboard helper: copies text and flips `copied` true for
 * `resetDelayMs`, then back to false. Throws if the Clipboard API is
 * unavailable so callers can surface their own error feedback (toast, etc.).
 */
export function useCopyToClipboard (resetDelayMs = 2000) {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(async (text: string) => {
    if (!navigator.clipboard) throw new Error('Clipboard unavailable')
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), resetDelayMs)
  }, [resetDelayMs])

  return { copy, copied }
}
