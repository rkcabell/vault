'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { SearchMatch, TextSegment } from '@/lib/media/types'
import { searchSegments } from '@/lib/media/searchSegments'

type SearchResult = {
  matches: SearchMatch[]
  totalMatches: number
}

type SearchOpts = {
  maxMatches?: number
  previewRadius?: number
}

type WorkerResponse = {
  id: number
  matches: SearchMatch[]
  totalMatches: number
}

/**
 * Runs text search in a Web Worker to avoid blocking the main thread.
 * Falls back to synchronous search if the Worker API is unavailable.
 *
 * To revert to sync search, replace `useSearchWorker` with direct
 * `searchSegments` calls in MediaTextContent.
 */
export function useSearchWorker() {
  const workerRef = useRef<Worker | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (typeof Worker === 'undefined') return

    try {
      const worker = new Worker('/searchWorker.js')
      worker.onerror = () => {
        // Worker failed to load — fall back to sync search via the null check in `search`
        workerRef.current = null
      }
      workerRef.current = worker
    } catch {
      // Fallback: sync search
    }

    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  const search = useCallback(
    (
      segments: TextSegment[],
      query: string,
      opts: SearchOpts = {},
      onResult: (result: SearchResult) => void,
    ) => {
      const id = ++requestIdRef.current
      const worker = workerRef.current

      if (!worker) {
        // Sync fallback
        const trimmed = query.trim()
        if (!trimmed) {
          onResult({ matches: [], totalMatches: 0 })
          return
        }
        onResult(searchSegments(segments, trimmed, opts))
        return
      }

      // Only the latest response is used — stale IDs are discarded
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        if (e.data.id !== id) return
        onResult({ matches: e.data.matches, totalMatches: e.data.totalMatches })
      }

      worker.postMessage({
        id,
        segments,
        query,
        maxMatches: opts.maxMatches ?? 1000,
        previewRadius: opts.previewRadius ?? 60,
      })
    },
    [],
  )

  return { search }
}
