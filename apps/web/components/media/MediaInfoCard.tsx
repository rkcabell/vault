'use client'

import React from 'react'
import { Button } from '@/components/ui/Button'

export function MediaInfoCard (props: {
  onDownload: () => Promise<void>
  onEmail: () => void
  onDelete: (e: React.MouseEvent) => void
  onRegenerateThumbnail: () => Promise<void>
  busy: boolean
}) {
  const { onDownload, onEmail, onDelete, onRegenerateThumbnail, busy } = props

  return (
    <div className='flex flex-col gap-2'>
      <Button onClick={onDownload} disabled={busy}>
        Download
      </Button>
      <Button variant='outline' onClick={onEmail} disabled={busy}>
        Email this file
      </Button>
      <Button variant='outline' onClick={onRegenerateThumbnail} disabled={busy}>
        Regenerate thumbnail
      </Button>
      <Button variant='destructive' onClick={(e) => onDelete(e)} disabled={busy}>
        Delete
      </Button>
    </div>
  )
}
