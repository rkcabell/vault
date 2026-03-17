import { useState, type ReactNode } from 'react'
import { HelpCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { app } from '@/lib/app'

export function TextEmptyState (props: {
  onRunExtraction?: () => Promise<void> | void
  isSubmitting?: boolean
  isDeleting: boolean
  actions?: ReactNode
}) {
  const { onRunExtraction, isSubmitting = false, isDeleting, actions } = props
  const [showEmptyHelp, setShowEmptyHelp] = useState(false)
  app.log.debug('TextEmptyState render')

  const showDefaultButton = !!onRunExtraction && !actions

  return (
    <div className='rounded-md border bg-muted/30 p-4'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='space-y-1'>
          <div className='font-medium'>No extracted text yet</div>
          <p className='text-sm text-muted-foreground'>
            Run extraction to generate searchable text.
          </p>
        </div>
        {(showDefaultButton || actions) && (
          <div className='flex flex-wrap items-center gap-2'>
            {showDefaultButton && (
              <Button
                size='sm'
                onClick={onRunExtraction}
                disabled={isSubmitting || isDeleting}
              >
                {isSubmitting ? 'Queuing...' : 'Run extraction'}
              </Button>
            )}
            {actions}
          </div>
        )}
      </div>
      <div className='mt-3 flex flex-wrap items-center gap-2'>
        <Button
          variant='ghost'
          size='sm'
          className='px-2'
          onClick={() => setShowEmptyHelp(value => !value)}
          aria-expanded={showEmptyHelp}
        >
          <HelpCircle className='mr-1 h-4 w-4' />
          Why might this be empty?
        </Button>
      </div>
      {showEmptyHelp && (
        <div className='mt-2 rounded-md bg-white/60 p-3 text-xs text-muted-foreground'>
          <ul className='list-disc space-y-1 pl-4'>
            <li>Extraction completed but found no readable text in the file.</li>
            <li>A previous extraction attempt may have failed — try running it again.</li>
            <li>The file may not contain any text (e.g. a photo with no writing).</li>
          </ul>
        </div>
      )}
    </div>
  )
}
