'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { Check, Copy, FolderOpen, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ARCHIVE_MIME_TYPES } from '@/lib/media/utils'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { toast } from '@/components/ui/Toaster'

export function MediaInfoCard (props: {
  onDownload: () => Promise<void>
  onDelete: (e: React.MouseEvent) => void
  onRegenerateThumbnail: () => Promise<void>
  onUnpackToBundle?: () => Promise<void>
  onRevealInExplorer?: () => Promise<void>
  busy: boolean
  mimeType?: string | null
  linkedBundleId?: string | null
  /** Non-null when the file has a local path (in-place or fs-driver). */
  localPath?: string | null
  /** S3 key shown in the tooltip when the file is cloud-stored and can't be revealed. */
  storageKey?: string | null
  /** Server can open a native file manager. Omitted/undefined is treated as true (back-compat). */
  localExplorer?: boolean
}) {
  const { onDownload, onDelete, onRegenerateThumbnail, onUnpackToBundle, onRevealInExplorer, busy, mimeType, linkedBundleId, localPath, storageKey, localExplorer } = props
  const isArchive = mimeType ? ARCHIVE_MIME_TYPES.has(mimeType) : false
  const [unpacking, setUnpacking] = useState(false)
  const { copy, copied } = useCopyToClipboard()
  const canReveal = !!localPath
  const showExplorer = localExplorer !== false

  const handleCopyPath = async () => {
    if (!localPath) return
    try {
      await copy(localPath)
    } catch {
      toast('Failed to copy path', { variant: 'error' })
    }
  }

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
      {canReveal && (
        <Button variant='outline' className='w-full' onClick={handleCopyPath} disabled={busy}>
          {copied ? <Check className='mr-2 h-4 w-4' /> : <Copy className='mr-2 h-4 w-4' />}
          {copied ? 'Copied!' : 'Copy Path'}
        </Button>
      )}
      {showExplorer && (
        <div className='relative group'>
          <Button
            variant='outline'
            className='w-full'
            onClick={canReveal ? onRevealInExplorer : undefined}
            disabled={busy || !canReveal}
          >
            <FolderOpen className='mr-2 h-4 w-4' />
            Open in File Explorer
          </Button>
          {!canReveal && (
            <div className='pointer-events-none absolute bottom-full left-1/2 mb-2 w-64 -translate-x-1/2 rounded bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md border border-border opacity-0 group-hover:opacity-100 transition-opacity z-50'>
              No local path available for this file.
              {storageKey && (
                <span className='mt-1 block break-all font-mono text-muted-foreground'>
                  Key: {storageKey}
                </span>
              )}
            </div>
          )}
        </div>
      )}
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
