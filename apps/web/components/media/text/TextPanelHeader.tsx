import { Badge } from '@/components/ui/Badge'
import type { TextLanguageStatus } from '@/lib/media/types'
import { cn } from '@/lib/utils'

type StatusChip = { label: string; variant: 'destructive' | 'secondary' | 'default' }

export function TextPanelHeader (props: {
  statusChip: StatusChip
  sourceLabel: string | null
  lastUpdatedText: string | null
  showMetadata: boolean
  languageLabel?: string | null
  languageStatus?: TextLanguageStatus | null
  languageOverride?: boolean
}) {
  const {
    statusChip,
    sourceLabel,
    lastUpdatedText,
    showMetadata,
    languageLabel,
    languageStatus,
    languageOverride = false
  } = props

  const languageBadgeLabel = showMetadata
    ? (languageStatus === 'error' ? 'Unknown language' : languageLabel ?? null)
    : null
  const languageVariant =
    languageStatus === 'error' ? 'outline' : 'outline'
  const languageTitle =
    languageStatus === 'error'
      ? 'Language could not be detected.'
      : languageStatus === 'short'
      ? languageOverride
        ? 'Short sample (<100 characters). Using selected language.'
        : 'Short sample (<100 characters). Detection may be inaccurate.'
      : undefined
  const languageClassName =
    languageStatus === 'short'
      ? 'border-yellow-300 bg-yellow-50 text-yellow-900'
      : undefined

  return (
    <div className='flex flex-wrap items-start justify-between gap-3'>
      <div className='space-y-1'>
        <h2 className='text-lg font-semibold'>Searchable text</h2>
        <div className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
          <Badge
            variant={statusChip.variant}
            className='rounded-full px-3 py-1 text-[11px] pointer-events-none'
          >
            {statusChip.label}
          </Badge>
          {showMetadata && sourceLabel && (
            <Badge
              variant='outline'
              className='rounded-full px-3 py-1 text-[11px]'
              title={sourceLabel === 'OCR' ? 'OCR = text recognized from an image or scanned PDF.' : undefined}
            >
              {sourceLabel}
            </Badge>
          )}
          {languageBadgeLabel && (
            <Badge
              variant={languageVariant}
              className={cn('rounded-full px-3 py-1 text-[11px]', languageClassName)}
              title={languageTitle}
            >
              {languageStatus === 'short'
                ? `⚠ ${languageBadgeLabel}`
                : languageBadgeLabel}
            </Badge>
          )}
          {lastUpdatedText && (
            <span className='text-[11px]'>Last updated {lastUpdatedText}</span>
          )}
        </div>
      </div>
    </div>
  )
}
