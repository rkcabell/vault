import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/utils'
import { app } from '@/lib/app'
import { ResultsPanel, type ResultsPanelItem } from './ResultsPanel'
import {
  Search,
  Type
} from 'lucide-react'

export function TextViewer (props: {
  listContent: ReactNode
  isMonospace: boolean
  onToggleMonospace: () => void
  searchTerm: string
  onSearchTermChange: (value: string) => void
  onSearchKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  matchPositionLabel: string
  onCopySelected: () => Promise<void> | void
  onCopyFull: () => Promise<void> | void
  isCopyDisabled: boolean
  isCopying: boolean
  lastCopyAction: 'selected' | 'full' | null
  copyMessage: string | null
  results: ResultsPanelItem[]
  activeMatchIndex: number
  onSelectMatch: (index: number) => void
}) {
  const {
    listContent,
    isMonospace,
    onToggleMonospace,
    searchTerm,
    onSearchTermChange,
    onSearchKeyDown,
    matchPositionLabel,
    onCopySelected,
    onCopyFull,
    isCopyDisabled,
    isCopying,
    lastCopyAction,
    copyMessage,
    results,
    activeMatchIndex,
    onSelectMatch
  } = props

  const hasSearchTerm = searchTerm.trim().length > 0
  const [showResults, setShowResults] = useState(true)
  const shouldShowResultsPanel = hasSearchTerm
  const shouldShowResultsList = showResults && hasSearchTerm

  const handleCopySelected = async () => {
    app.log.info('text copied', { mode: 'selected' })
    await onCopySelected()
  }

  const handleCopyFull = async () => {
    app.log.info('text copied', { mode: 'full' })
    await onCopyFull()
  }

  return (
    <div className='rounded-md border'>
      <div className='flex h-80 flex-col'>
        <div
          className='border-b bg-background px-3 py-2'
          data-text-viewer-header
        >
          <div className='relative flex flex-wrap items-center gap-3'>
            <div className='flex items-center gap-2'>
              <Button
                variant={isMonospace ? 'secondary' : 'outline'}
                size='sm'
                onClick={onToggleMonospace}
                aria-pressed={isMonospace}
              >
                <Type className='mr-2 h-4 w-4' />
                Monospace
              </Button>
            </div>

            <div className='flex min-w-0 flex-1 flex-wrap items-center gap-2'>
              <div className='flex min-w-[220px] flex-1 items-center gap-2 rounded-md border bg-background px-2'>
                <Search className='h-4 w-4 text-muted-foreground' />
                <Input
                  value={searchTerm}
                  onChange={e => onSearchTermChange(e.target.value)}
                  onKeyDown={onSearchKeyDown}
                  placeholder='Search within text'
                  className='h-8 border-none px-0 focus-visible:ring-0'
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
            <div className='relative ml-auto flex flex-wrap items-center gap-2'>
              <Button
                variant='outline'
                size='sm'
                onClick={handleCopySelected}
                disabled={isCopyDisabled}
              >
                {isCopying && lastCopyAction === 'selected' ? 'Copying...' : 'Copy selected'}
              </Button>
              <Button
                variant='outline'
                size='sm'
                onClick={handleCopyFull}
                disabled={isCopyDisabled}
              >
                {isCopying && lastCopyAction === 'full' ? 'Copying...' : 'Copy full'}
              </Button>

              {copyMessage && (
                <div
                  role='status'
                  className='pointer-events-none absolute right-0 bottom-full mb-2 rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white shadow-lg ring-1 ring-emerald-500/50 transition-all duration-200 ease-out animate-in fade-in slide-in-from-top-1'
                >
                  {copyMessage}
                </div>
              )}
            </div>
          </div>
        </div>
        <div
          className={cn(
            'min-h-0 flex-1'
          )}
        >
          <div className='flex h-full flex-col md:flex-row'>
            {shouldShowResultsPanel && (
              <div
                className={cn(
                  'order-1 flex-shrink-0 border-b md:order-2 md:border-b-0 md:border-l',
                  shouldShowResultsList ? 'h-40 md:h-full md:w-72' : 'h-auto md:h-auto md:w-72',
                )}
              >
                <ResultsPanel
                  results={results}
                  activeMatchIndex={activeMatchIndex}
                  onSelectMatch={onSelectMatch}
                  showList={shouldShowResultsList}
                />
              </div>
            )}
              <div
                className={cn(
                  'order-2 flex-1 min-h-0 h-full text-sm leading-relaxed text-foreground',
                  isMonospace ? 'font-mono' : 'font-sans',
                  shouldShowResultsPanel ? 'md:order-1' : 'order-1'
                )}
              >
              {listContent}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
