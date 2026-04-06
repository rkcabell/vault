'use client'

import React, { memo, useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'

const RESULTS_PAGE_SIZE = 25

export type ResultsPanelItem = {
  matchIndex: number
  segmentId: number
  segmentLabel: string
  previewText: string
  previewMatchStart: number
  previewMatchEnd: number
}

type ResultsPanelProps = {
  results: ResultsPanelItem[]
  activeMatchIndex: number
  onSelectMatch: (index: number) => void
  onClose?: () => void
  showList?: boolean
}

type ResultRowProps = {
  result: ResultsPanelItem
  total: number
  isActive: boolean
  onSelectMatch: (index: number) => void
}

const ResultRow = memo(function ResultRow(props: ResultRowProps) {
  const { result, total, isActive, onSelectMatch } = props
  const { previewText, previewMatchStart, previewMatchEnd } = result

  const { prefix, matchText, suffix } = useMemo(() => {
    const safeStart = Math.max(0, Math.min(previewMatchStart, previewText.length))
    const safeEnd = Math.max(safeStart, Math.min(previewMatchEnd, previewText.length))

    return {
      prefix: previewText.slice(0, safeStart),
      matchText: previewText.slice(safeStart, safeEnd),
      suffix: previewText.slice(safeEnd),
    }
  }, [previewText, previewMatchStart, previewMatchEnd])

  return (
    <button
      type="button"
      onClick={() => onSelectMatch(result.matchIndex)}
      className={cn(
        'w-full border-b px-3 py-2 text-left transition-colors focus-visible:outline-none',
        isActive
          ? 'bg-primary/10 hover:bg-primary/20 focus-visible:bg-primary/20'
          : 'hover:bg-muted/40 focus-visible:bg-muted/50'
      )}
      aria-current={isActive ? 'true' : undefined}
    >
      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span>{result.matchIndex + 1} of {total}</span>
        {result.segmentLabel && <span>{result.segmentLabel}</span>}
      </div>
      <div className="mt-1 text-xs text-foreground/90">
        {prefix}
        <mark className="rounded bg-primary/20 px-0.5 text-foreground">
          {matchText}
        </mark>
        {suffix}
      </div>
    </button>
  )
})

ResultRow.displayName = 'ResultRow'

export function ResultsPanel(props: ResultsPanelProps) {
  const { results, activeMatchIndex, onSelectMatch, onClose, showList = true } = props

  const totalPages = Math.max(1, Math.ceil(results.length / RESULTS_PAGE_SIZE))
  const [currentPage, setCurrentPage] = useState(0)

  // Reset to page 0 when the result set changes (new search term)
  useEffect(() => {
    setCurrentPage(0)
  }, [results.length])

  const visibleResults = useMemo(() => {
    const start = currentPage * RESULTS_PAGE_SIZE
    return results.slice(start, start + RESULTS_PAGE_SIZE)
  }, [results, currentPage])

  const pageStart = currentPage * RESULTS_PAGE_SIZE

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span>{results.length} Results</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close results panel"
            className="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {showList && totalPages > 1 && (
        <div className="flex items-center justify-between border-b px-2 py-1.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
            disabled={currentPage === 0}
            aria-label="Previous results page"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs text-muted-foreground">
            {pageStart + 1}–{Math.min(results.length, pageStart + RESULTS_PAGE_SIZE)} of {results.length}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={currentPage === totalPages - 1}
            aria-label="Next results page"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      {showList && (
        <div className="vault-scrollbar min-h-0 flex-1 overflow-y-auto">
          {results.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted-foreground">No matches</div>
          ) : (
            visibleResults.map((result) => (
              <ResultRow
                key={result.matchIndex}
                result={result}
                total={results.length}
                isActive={result.matchIndex === activeMatchIndex}
                onSelectMatch={onSelectMatch}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}
