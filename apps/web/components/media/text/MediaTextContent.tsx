import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { usePreferences } from '@/hooks/usePreferences'
import { useTextHighlighter } from '@/hooks/media/useTextHighlighter'
import { useSearchWorker } from '@/hooks/media/useSearchWorker'
import type { SearchMatch, TextSegment } from '@/lib/media/types'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { scrollToMatchInContainer } from '@/lib/scrollToMatchInContainer'
import { TextViewer } from './TextViewer'
import { getMatchPositionLabel } from './textPanel-utils'
import { TextSegmentList } from './TextSegmentList'
import {
  VirtualTextSegmentList,
  type VirtualTextSegmentListHandle,
} from './VirtualTextSegmentList'
import type { ResultsPanelItem } from './ResultsPanel'
import { Button } from '@/components/ui/Button'
import { ChevronLeft, ChevronRight } from 'lucide-react'

// ─── Toggle ──────────────────────────────────────────────────────────────────
// Set to false to revert to the page-based TextSegmentList (no react-window).
const USE_VIRTUAL_SCROLL = true
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50

export function MediaTextContent(props: {
  segments: TextSegment[]
  highlightTerms: string[]
  containerRef?: RefObject<HTMLDivElement | null>
  copyMessage: string | null
  copySelected: (fallbackText?: string) => Promise<void>
  copyFull: () => Promise<void>
  isCopyDisabled: boolean
}) {
  const {
    segments,
    highlightTerms,
    containerRef,
    copyMessage,
    copySelected,
    copyFull,
    isCopyDisabled,
  } = props

  const totalChars = useMemo(
    () => segments.reduce((sum, s) => sum + (s.text?.length ?? 0), 0),
    [segments],
  )
  const defaultViewerHeight = totalChars > 999 ? '40rem' : totalChars > 499 ? '30rem' : '20rem'

  const [isMonospace, setIsMonospace] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const debouncedSearchTerm = useDebouncedValue(searchTerm, 150)

  const [matches, setMatches] = useState<SearchMatch[]>([])
  const [totalMatches, setTotalMatches] = useState(0)
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1)

  // Page state — only used when USE_VIRTUAL_SCROLL = false
  const [currentPage, setCurrentPage] = useState(0)

const localScrollContainerRef = useRef<HTMLDivElement | null>(null)
  const scrollContainerRef = containerRef ?? localScrollContainerRef

  // Ref for the virtual list — only used when USE_VIRTUAL_SCROLL = true
  const virtualListRef = useRef<VirtualTextSegmentListHandle>(null)

  // Queued scroll for page-based navigation (fires after page re-render)
  const pendingScrollMatchRef = useRef<SearchMatch | null>(null)

  const { search } = useSearchWorker()

  // Reset page to 0 when segments change (different media)
  useEffect(() => {
    setCurrentPage(0)
  }, [segments])

  // Reset page to 0 when search is cleared
  useEffect(() => {
    if (!debouncedSearchTerm.trim()) setCurrentPage(0)
  }, [debouncedSearchTerm])

  // Run search — off-thread via worker, sync fallback if worker unavailable
  useEffect(() => {
    const trimmed = debouncedSearchTerm.trim()
    if (!trimmed) {
      setMatches([])
      setTotalMatches(0)
      setActiveMatchIndex(-1)
      return
    }

    search(segments, trimmed, { maxMatches: 1000, previewRadius: 60 }, (result) => {
      setMatches(result.matches)
      setTotalMatches(result.totalMatches)
      setActiveMatchIndex(result.matches.length > 0 ? 0 : -1)
    })
  }, [debouncedSearchTerm, segments, search])

  const { prefs } = usePreferences()
  const { renderSegment } = useTextHighlighter({ highlightTerms, yellowHighlight: prefs.yellowHighlight })

  const matchesBySegmentId = useMemo(() => {
    const map = new Map<number, SearchMatch[]>()
    for (const match of matches) {
      const list = map.get(match.segmentId) ?? []
      list.push(match)
      map.set(match.segmentId, list)
    }
    return map
  }, [matches])

  const segmentIndexById = useMemo(() => {
    const map = new Map<number, number>()
    segments.forEach((segment, index) => map.set(segment.segmentId, index))
    return map
  }, [segments])

  const segmentLabelById = useMemo(() => {
    const map = new Map<number, string>()
    segments.forEach((segment) => {
      const orderValue = segment.order
      const hasOrder = typeof orderValue === 'number' && !Number.isNaN(orderValue)
      const label = hasOrder && orderValue > 0 ? `Page ${orderValue}` : ''
      map.set(segment.segmentId, label)
    })
    return map
  }, [segments])

  const results = useMemo<ResultsPanelItem[]>(() => {
    return matches.map((match, matchIndex) => {
        return {
        matchIndex,
        segmentId: match.segmentId,
        segmentLabel: segmentLabelById.get(match.segmentId) ?? '',
        previewText: match.previewText,
        previewMatchStart: match.previewStart,
        previewMatchEnd: match.previewEnd,
      }
    })
  }, [matches, segmentLabelById])

  // Page-based: pagination controls + sliced segments
  const totalPages = segments.length > 0 ? Math.ceil(segments.length / PAGE_SIZE) : 1
  const pageSegments = useMemo(
    () => segments.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE),
    [segments, currentPage],
  )

  const activeMatch = matches[activeMatchIndex] ?? null
  const activeMatchId = activeMatch?.matchId ?? null

  useEffect(() => {
    if (activeMatchIndex >= matches.length && matches.length > 0) {
      setActiveMatchIndex(matches.length - 1)
    }
  }, [activeMatchIndex, matches.length])

  // Page-based: scroll to pending match after page change
  useEffect(() => {
    if (USE_VIRTUAL_SCROLL) return
    const match = pendingScrollMatchRef.current
    if (!match) return
    pendingScrollMatchRef.current = null
    const id = window.setTimeout(() => {
      const container = scrollContainerRef.current
      if (container) scrollToMatchInContainer(container, match.matchId)
    }, 0)
    return () => window.clearTimeout(id)
  }, [currentPage, scrollContainerRef])

  const jumpToMatch = (match: SearchMatch) => {
    if (USE_VIRTUAL_SCROLL) {
      const container = scrollContainerRef.current
      // If the match element is already rendered (within overscan), fine-scroll only.
      if (container && scrollToMatchInContainer(container, match.matchId)) return
      // Segment not in the DOM yet — coarse scroll to bring it into view, then fine-scroll.
      const segIdx = segmentIndexById.get(match.segmentId) ?? 0
      virtualListRef.current?.scrollToSegment(segIdx)
      window.setTimeout(() => {
        const c = scrollContainerRef.current
        if (c) scrollToMatchInContainer(c, match.matchId)
      }, 50)
    } else {
      const targetPage = Math.floor((segmentIndexById.get(match.segmentId) ?? 0) / PAGE_SIZE)
      if (targetPage !== currentPage) {
        pendingScrollMatchRef.current = match
        setCurrentPage(targetPage)
      } else {
        const container = scrollContainerRef.current
        if (container) scrollToMatchInContainer(container, match.matchId)
      }
    }
  }

  const handleSelectMatch = (index: number) => {
    const match = matches[index]
    if (!match) return
    setActiveMatchIndex(index)
    jumpToMatch(match)
  }

  const handleCopySelectedClick = async () => {
    await copySelected(searchTerm.trim() || undefined)
  }

  const handleCopyFullClick = async () => {
    await copyFull()
  }

  const matchPositionLabel =
    totalMatches > matches.length
      ? `${Math.max(activeMatchIndex + 1, 0)} of ${matches.length}+`
      : getMatchPositionLabel(activeMatchIndex, matches.length)

  const paginationControls = !USE_VIRTUAL_SCROLL && totalPages > 1 ? (
    <div className="flex items-center justify-center gap-2 border-t px-4 py-2 text-sm text-muted-foreground">
      <Button
        variant="outline"
        size="icon"
        onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
        disabled={currentPage === 0}
        aria-label="Previous page"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="min-w-[100px] text-center">
        Page {currentPage + 1} of {totalPages}
      </span>
      <Button
        variant="outline"
        size="icon"
        onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
        disabled={currentPage === totalPages - 1}
        aria-label="Next page"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  ) : null

  const listContent = (
    <div className="flex h-full flex-col min-h-0">
      {USE_VIRTUAL_SCROLL ? (
        <VirtualTextSegmentList
          ref={virtualListRef}
          scrollContainerRef={scrollContainerRef}
          segments={segments}
          matchesBySegmentId={matchesBySegmentId}
          activeMatchId={activeMatchId}
          renderSegment={renderSegment}
          className="flex-1 min-h-0"
        />
      ) : (
        <>
          <TextSegmentList
            scrollContainerRef={scrollContainerRef}
            segments={pageSegments}
            matchesBySegmentId={matchesBySegmentId}
            activeMatchId={activeMatchId}
            renderSegment={renderSegment}
            className="flex-1 min-h-0 p-4"
          />
          {paginationControls}
        </>
      )}
    </div>
  )

  return (
    <TextViewer
      listContent={listContent}
      defaultHeight={defaultViewerHeight}
      isMonospace={isMonospace}
      onToggleMonospace={() => setIsMonospace((value) => !value)}
      searchTerm={searchTerm}
      onSearchTermChange={setSearchTerm}
      matchPositionLabel={matchPositionLabel}
      onCopySelected={handleCopySelectedClick}
      onCopyFull={handleCopyFullClick}
      isCopyDisabled={isCopyDisabled}
      copyMessage={copyMessage}
      results={results}
      activeMatchIndex={activeMatchIndex}
      onSelectMatch={handleSelectMatch}
    />
  )
}
