'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { readErrorMessage } from '@/lib/media/utils'
import { emitBundlesUpdated } from '@/lib/bundles'

interface Bundle {
  id: string
  name: string
}

interface MediaBundlesPanelProps {
  mediaId: string
  memberBundles: Bundle[]
  disabled?: boolean
  onRemoved?: () => void
}

export function MediaBundlesPanel ({
  mediaId,
  memberBundles,
  disabled,
  onRemoved,
}: MediaBundlesPanelProps) {
  const [isRemoving, setIsRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const removeFromBundle = async (bundleId: string) => {
    setIsRemoving(true)
    setError(null)
    try {
      const res = await fetch(`/api/bundles/${bundleId}/items/${mediaId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!res.ok) {
        const msg = await readErrorMessage(res, 'Failed to remove from bundle.')
        setError(msg)
        return
      }
      emitBundlesUpdated()
      onRemoved?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove from bundle.')
    } finally {
      setIsRemoving(false)
    }
  }

  const removeFromAll = async () => {
    setIsRemoving(true)
    setError(null)
    try {
      const results = await Promise.allSettled(
        memberBundles.map(b =>
          fetch(`/api/bundles/${b.id}/items/${mediaId}`, {
            method: 'DELETE',
            credentials: 'include',
          })
        )
      )
      const anyFailed = results.some(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok))
      if (anyFailed) {
        setError('Some removals failed. Please try again.')
      }
      emitBundlesUpdated()
      onRemoved?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove from bundles.')
    } finally {
      setIsRemoving(false)
    }
  }

  const busy = disabled || isRemoving

  return (
    <div className='flex flex-col gap-2'>
      {memberBundles.map(b => (
        <Link
          key={b.id}
          href={`/bundles/${b.id}`}
          className='inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors truncate'
        >
          {b.name} →
        </Link>
      ))}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant='outline' disabled={busy}>
            {isRemoving ? 'Removing…' : 'Remove from bundle'}
          <ChevronDown className='ml-2 h-4 w-4' />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {memberBundles.length > 1 && (
            <>
              <DropdownMenuItem variant='destructive' onSelect={() => void removeFromAll()}>
                Remove from all bundles
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {memberBundles.map(b => (
            <DropdownMenuItem key={b.id} onSelect={() => void removeFromBundle(b.id)}>
              {b.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {error && (
        <p className='text-xs text-destructive'>{error}</p>
      )}
    </div>
  )
}
