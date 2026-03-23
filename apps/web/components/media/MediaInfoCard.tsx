'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ARCHIVE_MIME_TYPES } from '@/lib/media/utils'

export function MediaInfoCard (props: {
  onDownload: () => Promise<void>
  onDelete: (e: React.MouseEvent) => void
  onRegenerateThumbnail: () => Promise<void>
  onUnpackToBundle?: () => Promise<void>
  busy: boolean
  mimeType?: string | null
  linkedBundleId?: string | null
}) {
  const { onDownload, onDelete, onRegenerateThumbnail, onUnpackToBundle, busy, mimeType, linkedBundleId } = props
  const isArchive = mimeType ? ARCHIVE_MIME_TYPES.has(mimeType) : false
  const [unpacking, setUnpacking] = useState(false)

  const handleUnpack = async () => {
    if (!onUnpackToBundle) return
    setUnpacking(true)
    try {
      await onUnpackToBundle()
    } finally {
      setUnpacking(false)
    }
  }

  return (
    <div className='flex flex-col gap-2'>
      <Button onClick={onDownload} disabled={busy}>
        Download
      </Button>
      {isArchive && !linkedBundleId && onUnpackToBundle && (
        <Button variant='outline' onClick={handleUnpack} disabled={busy || unpacking}>
          {unpacking ? <Loader2 className='h-4 w-4 animate-spin' /> : 'Unpack into Bundle'}
        </Button>
      )}
      {linkedBundleId && (
        <Link
          href={`/bundles/${linkedBundleId}`}
          className='inline-flex items-center justify-center rounded-md border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted transition-colors'
        >
          View Bundle →
        </Link>
      )}
      <Button variant='outline' onClick={onRegenerateThumbnail} disabled={busy}>
        Regenerate thumbnail
      </Button>
      <Button variant='destructive' onClick={(e) => onDelete(e)} disabled={busy}>
        Delete
      </Button>
    </div>
  )
}
