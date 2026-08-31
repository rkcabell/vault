import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getTextQueuePosition, prioritizeMediaText, type TextQueuePosition } from '@/lib/media/textClient'

/**
 * Shown for a row still sitting in the database backlog — `textState` PENDING
 * with no `textQueuedAt`. Once the feeder dispatches it, TextRunningBanner
 * takes over and this unmounts.
 */
export function TextQueuedBanner (props: {
  mediaId: string
  onPrioritized?: () => void
  onError?: (message: string) => void
}) {
  const { mediaId, onPrioritized, onError } = props
  const [place, setPlace] = useState<TextQueuePosition | null>(null)
  const [isPromoting, setIsPromoting] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getTextQueuePosition(mediaId).then(next => {
      if (!cancelled) setPlace(next)
    })
    return () => { cancelled = true }
  }, [mediaId])

  const handlePrioritize = async () => {
    if (isPromoting) return
    setIsPromoting(true)
    try {
      await prioritizeMediaText(mediaId)
      onPrioritized?.()
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Unable to move this file to the front.')
    } finally {
      setIsPromoting(false)
    }
  }

  return (
    <div className='rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex items-center gap-2'>
          <Clock className='h-4 w-4' />
          <span className='tabular-nums'>
            Queued for extraction
            {place && ` — #${place.position.toLocaleString()} of ${place.total.toLocaleString()}`}
          </span>
        </div>
        <Button
          size='sm'
          variant='ghost'
          className='h-7 px-2 text-muted-foreground hover:text-foreground'
          onClick={handlePrioritize}
          disabled={isPromoting}
        >
          {isPromoting ? 'Moving...' : 'Move to front'}
        </Button>
      </div>
    </div>
  )
}
