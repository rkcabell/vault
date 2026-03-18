import { type ReactNode } from 'react'
import { Info } from 'lucide-react'
import { app } from '@/lib/app'

export function TextErrorPanel (props: {
  message: string | null
  detail?: string | null
  actions?: ReactNode
}) {
  const { message: errorMessage, detail: errorDetail, actions } = props
  app.log.debug('TextErrorPanel render')

  const hasDetail = Boolean(errorDetail && errorDetail !== errorMessage)

  return (
    <div className='text-error-panel space-y-2 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex items-center gap-2 font-medium'>
          <Info className='h-4 w-4' />
          <span>Text extraction failed{errorMessage ? `: ${errorMessage}` : '.'}</span>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          {actions}
        </div>
      </div>
      {hasDetail && (
        <div className='leading-relaxed'>
          {errorDetail}
        </div>
      )}
    </div>
  )
}
