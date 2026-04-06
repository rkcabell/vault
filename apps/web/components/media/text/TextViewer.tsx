'use client'

import { createPortal } from 'react-dom'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/utils'
import { app } from '@/lib/app'
import { usePreferences } from '@/hooks/usePreferences'
import { ResultsPanel, type ResultsPanelItem } from './ResultsPanel'
import { Highlighter, Search, Type } from 'lucide-react'

export function TextViewer (props: {
  listContent: ReactNode
  defaultHeight: string
  isMonospace: boolean
  onToggleMonospace: () => void
  searchTerm: string
  onSearchTermChange: (value: string) => void
  onSearchKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  matchPositionLabel: string
  onCopySelected: () => Promise<void> | void
  onCopyFull: () => Promise<void> | void
  isCopyDisabled: boolean
  copyMessage: string | null
  results: ResultsPanelItem[]
  activeMatchIndex: number
  onSelectMatch: (index: number) => void
}) {
  const {
    listContent,
    defaultHeight,
    isMonospace,
    onToggleMonospace,
    searchTerm,
    onSearchTermChange,
    onSearchKeyDown,
    matchPositionLabel,
    onCopySelected,
    onCopyFull,
    isCopyDisabled,
    copyMessage,
    results,
    activeMatchIndex,
    onSelectMatch,
  } = props

  const { prefs, updatePreferences } = usePreferences()
  const hasSearchTerm = searchTerm.trim().length > 0
  const [showResults, setShowResults] = useState(true)
  // The panel only renders when both a search term is active and showResults is true.
  // Hiding results collapses the panel entirely; highlights in the text remain
  // because they are driven by matchesBySegmentId, not by this toggle.
  const shouldShowResultsPanel = hasSearchTerm && showResults

  // Track the text viewer's viewport position so the portal panel can be
  // fixed-positioned to align with the viewer's right edge. A portal is
  // required because ancestor panels from react-resizable-panels have
  // overflow:hidden as inline styles, which would clip any absolute child
  // that extends beyond the panel boundary.
  const viewerRef = useRef<HTMLDivElement>(null)
  const [panelRect, setPanelRect] = useState<{ top: number; left: number; height: number } | null>(null)

  // Track copy buttons position for the toast portal.
  const copyButtonsRef = useRef<HTMLDivElement>(null)
  const [toastStyle, setToastStyle] = useState<React.CSSProperties | null>(null)

  useEffect(() => {
    if (!copyMessage) { setToastStyle(null); return }
    const el = copyButtonsRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setToastStyle({
      position: 'fixed',
      bottom: window.innerHeight - rect.top + 8,
      right: window.innerWidth - rect.right,
      zIndex: 60,
    })
  }, [copyMessage])

  useEffect(() => {
    if (!shouldShowResultsPanel) {
      setPanelRect(null)
      return
    }
    const update = () => {
      const el = viewerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      setPanelRect({ top: rect.top, left: rect.right, height: rect.height })
    }
    update()
    const ro = new ResizeObserver(update)
    if (viewerRef.current) ro.observe(viewerRef.current)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [shouldShowResultsPanel])

  const handleCopySelected = async () => {
    app.log.info('text copied', { mode: 'selected' })
    await onCopySelected()
  }

  const handleCopyFull = async () => {
    app.log.info('text copied', { mode: 'full' })
    await onCopyFull()
  }

  return (
    <div ref={viewerRef}>
      <div className='rounded-md border overflow-hidden resize-y' style={{ height: defaultHeight, minHeight: '12rem' }}>
        <div className='flex h-full flex-col'>
          <div
            className='border-b bg-background px-3 py-2'
            data-text-viewer-header
          >
            <div className='relative flex flex-wrap items-center gap-3'>
              <div className='flex items-center gap-2'>
                <Button
                  variant={isMonospace ? 'secondary' : 'outline'}
                  size='icon'
                  onClick={onToggleMonospace}
                  aria-pressed={isMonospace}
                  aria-label='Toggle monospace font'
                  title='Monospace'
                >
                  <Type className='h-4 w-4' />
                </Button>
                <Button
                  variant={prefs.yellowHighlight ? 'secondary' : 'outline'}
                  size='icon'
                  onClick={() => updatePreferences({ yellowHighlight: !prefs.yellowHighlight })}
                  aria-pressed={prefs.yellowHighlight}
                  aria-label='Toggle yellow highlights'
                  title='Yellow highlights'
                >
                  <Highlighter className='h-4 w-4' />
                </Button>
              </div>

              <div className='flex min-w-0 flex-1 flex-wrap items-center gap-2'>
                <div className='flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-2'>
                  <Search className='h-4 w-4 text-muted-foreground' />
                  <Input
                    value={searchTerm}
                    onChange={e => onSearchTermChange(e.target.value)}
                    onKeyDown={onSearchKeyDown}
                    placeholder='Search within text'
                    className='h-8 border-none bg-transparent px-0 focus-visible:ring-0'
                  />
                </div>
                {hasSearchTerm && (
                  <span className='text-xs text-muted-foreground'>{matchPositionLabel}</span>
                )}
                {hasSearchTerm && (
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={() => setShowResults((prev) => !prev)}
                    aria-pressed={showResults}
                  >
                    {showResults ? 'Hide results' : 'Show results'}
                  </Button>
                )}
              </div>
              <div ref={copyButtonsRef} className='ml-auto flex flex-wrap items-center gap-2'>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={handleCopySelected}
                  disabled={isCopyDisabled}
                >
                  Copy selected
                </Button>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={handleCopyFull}
                  disabled={isCopyDisabled}
                >
                  Copy full
                </Button>
              </div>
            </div>
          </div>
          <div className='min-h-0 flex-1'>
            <div
              className={cn(
                'h-full min-h-0 text-sm leading-relaxed text-foreground',
                isMonospace ? 'font-mono' : 'font-sans',
              )}
            >
              {listContent}
            </div>
          </div>
        </div>
      </div>

      {/* Copy toast rendered via portal for the same reason as the results panel. */}
      {copyMessage && toastStyle && createPortal(
        <div
          role='status'
          style={toastStyle}
          className='pointer-events-none rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white shadow-lg ring-1 ring-emerald-500/50 animate-in fade-in slide-in-from-top-1'
        >
          {copyMessage}
        </div>,
        document.body
      )}

      {/* Results panel rendered via portal so it escapes the left Panel's
          overflow:hidden and can float above the resizable separator. */}
      {shouldShowResultsPanel && panelRect && createPortal(
        <div
          style={{
            position: 'fixed',
            top: panelRect.top,
            left: panelRect.left,
            height: panelRect.height,
            width: 288,
            zIndex: 50,
          }}
          className='rounded-r-md border border-l-0 bg-background shadow-md overflow-hidden'
        >
          <ResultsPanel
            results={results}
            activeMatchIndex={activeMatchIndex}
            onSelectMatch={onSelectMatch}
            onClose={() => setShowResults(false)}
          />
        </div>,
        document.body
      )}
    </div>
  )
}
