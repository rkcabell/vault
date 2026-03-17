import { useMemo, useState } from 'react'
import { Loader2, RefreshCcw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cancelMediaTextExtraction, rerunMediaTextExtraction } from '@/lib/media/textClient'
import { app } from '@/lib/app'

type SubmitMode = 'default' | 'force'

type ExtractionActionButtonsProps = {
  mediaId: string
  onQueued: () => void
  onError?: (message: string) => void
  isDeleting: boolean
  primaryLabel: string
  pendingPrimaryLabel?: string
  primaryVariant?: 'default' | 'outline' | 'destructive'
  includeForceOcr?: boolean
  forceLabel?: string
  pendingForceLabel?: string
  forceVariant?: 'default' | 'outline' | 'destructive'
  disabled?: boolean
  className?: string
}

export function ExtractionActionButtons (props: ExtractionActionButtonsProps) {
  const {
    mediaId,
    onQueued,
    onError,
    isDeleting,
    primaryLabel,
    pendingPrimaryLabel = 'Queuing...',
    primaryVariant = 'default',
    includeForceOcr = false,
    forceLabel = 'Run OCR instead',
    pendingForceLabel = 'Queuing...',
    forceVariant = 'outline',
    disabled = false,
    className
  } = props

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [activeMode, setActiveMode] = useState<SubmitMode | null>(null)

  const handleSubmit = async (mode: SubmitMode) => {
    if (isSubmitting || isDeleting || disabled) return
    setIsSubmitting(true)
    setActiveMode(mode)

    try {
      app.log.info('extraction control submit', { mediaId, mode })
      const payload = mode === 'force' ? { forceOcr: true } : {}
      await rerunMediaTextExtraction(mediaId, payload)
      onQueued()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to re-run text extraction.'
      onError?.(message)
    } finally {
      setIsSubmitting(false)
      setActiveMode(null)
    }
  }

  return (
    <div className={className}>
      <div className='flex flex-wrap items-center gap-2'>
        <Button
          size='sm'
          variant={primaryVariant}
          onClick={() => handleSubmit('default')}
          disabled={isSubmitting || isDeleting || disabled}
        >
          {isSubmitting && activeMode === 'default'
            ? pendingPrimaryLabel
            : primaryLabel}
        </Button>
        {includeForceOcr && (
          <Button
            size='sm'
            variant={forceVariant}
            onClick={() => handleSubmit('force')}
            disabled={isSubmitting || isDeleting || disabled}
          >
            {isSubmitting && activeMode === 'force'
              ? pendingForceLabel
              : forceLabel}
          </Button>
        )}
      </div>
    </div>
  )
}

export function ExtractionControls (props: {
  mediaId: string
  isRunning: boolean
  isDeleting: boolean
  hasAnyText: boolean
  onQueued: () => void
  onError?: (message: string) => void
  onLanguageApplied?: (language: string | null) => void
  onCancelled?: () => void
}) {
  const {
    mediaId,
    isRunning,
    isDeleting,
    hasAnyText,
    onQueued,
    onError,
    onLanguageApplied,
    onCancelled
  } = props
  const [language, setLanguage] = useState('auto')
  const [rotation, setRotation] = useState('0')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)

  const advancedSummary = useMemo(() => {
    const languageLabel =
      language === 'auto' ? 'Auto-detect language' : `Language: ${language.toUpperCase()}`
    return `${languageLabel} | ${rotation} deg rotation`
  }, [language, rotation])

  const handleSubmit = async () => {
    if (isSubmitting || isDeleting || isRunning) return
    setIsSubmitting(true)
    const payload: { language?: string; rotation?: string } = {}
    if (language !== 'auto') payload.language = language
    if (rotation !== '0') payload.rotation = rotation

    try {
      app.log.info('extraction control submit', { mediaId, mode: 'default' })
      await rerunMediaTextExtraction(mediaId, payload)
      onQueued()
      onLanguageApplied?.(language === 'auto' ? null : language)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to re-run text extraction.'
      onError?.(message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = async () => {
    if (isCancelling || isDeleting) return
    setIsCancelling(true)
    try {
      await cancelMediaTextExtraction(mediaId)
      onCancelled?.()
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to cancel text extraction.'
      onError?.(message)
    } finally {
      setIsCancelling(false)
    }
  }

  const buttonLabel = (() => {
    if (isRunning) {
      return (
        <span className='flex items-center gap-2'>
          <Loader2 className='h-4 w-4 animate-spin' />
          Extraction in progress...
        </span>
      )
    }
    if (isSubmitting) {
      return (
        <span className='flex items-center gap-2'>
          <Loader2 className='h-4 w-4 animate-spin' />
          Queuing...
        </span>
      )
    }
    return hasAnyText ? 'Re-run extraction' : 'Run extraction'
  })()

  return (
    <div className='rounded-md border bg-muted/20 p-4 space-y-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='space-y-1'>
          <div className='text-sm font-medium'>Extract text</div>
          <div className='text-xs text-muted-foreground'>{advancedSummary}</div>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          {isRunning && (
            <Button
              variant='outline'
              onClick={handleCancel}
              disabled={isCancelling || isDeleting}
            >
              {isCancelling ? 'Stopping...' : 'Stop extraction'}
            </Button>
          )}
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || isDeleting || isRunning}
          >
            {buttonLabel}
          </Button>
        </div>
      </div>

      <div className='flex flex-wrap items-center gap-2'>
        <Button
          variant='ghost'
          size='sm'
          className='px-0'
          onClick={() => setShowAdvanced(value => !value)}
          aria-expanded={showAdvanced}
        >
          <RefreshCcw className='mr-2 h-4 w-4' />
          Advanced options
        </Button>
      </div>

      {showAdvanced && (
        <div className='grid gap-3 sm:grid-cols-2'>
          <div>
            <label className='text-xs text-muted-foreground'>Language</label>
            <select
              value={language}
              onChange={e => setLanguage(e.target.value)}
              disabled={isSubmitting || isDeleting}
              className='mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            >
              <option value='auto'>Auto-detect</option>
              <option value='en'>English</option>
              <option value='es'>Spanish</option>
              <option value='fr'>French</option>
              <option value='de'>German</option>
            </select>
            <p className='mt-1 text-xs text-muted-foreground'>
              Choose a language for better accuracy.
            </p>
          </div>
          <div>
            <label className='text-xs text-muted-foreground'>Rotation</label>
            <select
              value={rotation}
              onChange={e => setRotation(e.target.value)}
              disabled={isSubmitting || isDeleting}
              className='mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            >
              <option value='0'>0 deg (upright)</option>
              <option value='90'>90 deg</option>
              <option value='180'>180 deg</option>
              <option value='270'>270 deg</option>
            </select>
            <p className='mt-1 text-xs text-muted-foreground'>
              Use if the scan is sideways.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
