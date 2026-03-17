import { useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cancelMediaTextExtraction } from '@/lib/media/textClient'
import { app } from '@/lib/app'

export function TextRunningBanner (props: {
  mediaId: string
  onCancelled?: () => void
  onError?: (message: string) => void
}) {
  const { mediaId, onCancelled, onError } = props
  const [isCancelling, setIsCancelling] = useState(false)
  app.log.debug('TextRunningBanner render')

  const handleCancel = async () => {
    if (isCancelling) return
    setIsCancelling(true)
    try {
      await cancelMediaTextExtraction(mediaId)
      onCancelled?.()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to cancel text extraction.'
      onError?.(message)
    } finally {
      setIsCancelling(false)
    }
  }

  return (
    <div className='rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex items-center gap-2'>
          <Loader2 className='h-4 w-4 animate-spin' />
          <span>Extraction in progress...</span>
        </div>
        <Button
          size='sm'
          variant='ghost'
          className='h-7 px-2 text-muted-foreground hover:text-foreground'
          onClick={handleCancel}
          disabled={isCancelling}
        >
          <X className='h-3.5 w-3.5' />
          {isCancelling ? 'Stopping...' : 'Abort'}
        </Button>
      </div>
    </div>
  )
}
