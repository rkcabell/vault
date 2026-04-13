'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'

type ReminderItem = {
  id: string
  title: string
  note: string | null
  remindAt: string
  dueAt: string
}

interface MediaRemindersPanelProps {
  reminders: ReminderItem[]
  onUpdated?: () => void
}

function formatDueDate(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function MediaRemindersPanel({ reminders, onUpdated }: MediaRemindersPanelProps) {
  const [completing, setCompleting] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const completeReminder = async (id: string) => {
    setCompleting(prev => new Set(prev).add(id))
    setError(null)
    try {
      const res = await fetch(`/api/reminders/${id}/complete`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) {
        let msg = 'Failed to complete reminder.'
        try {
          const data = await res.json() as { message?: string }
          if (data?.message) msg = data.message
        } catch { /* ignore */ }
        setError(msg)
        return
      }
      onUpdated?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete reminder.')
    } finally {
      setCompleting(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  return (
    <div className='flex flex-col gap-3'>
      {reminders.map(r => (
        <div
          key={r.id}
          className='flex items-start justify-between gap-3 rounded-md border border-input bg-background px-4 py-3'
        >
          <div className='min-w-0 flex-1'>
            <p className='text-sm font-medium leading-snug truncate'>{r.title}</p>
            <p className='text-xs text-muted-foreground mt-0.5'>Due {formatDueDate(r.dueAt)}</p>
            {r.note && (
              <p className='text-xs text-muted-foreground mt-1 truncate'>{r.note}</p>
            )}
          </div>
          <Button
            variant='outline'
            size='sm'
            disabled={completing.has(r.id)}
            onClick={() => void completeReminder(r.id)}
            className='shrink-0 text-xs'
          >
            {completing.has(r.id) ? 'Completing…' : 'Complete'}
          </Button>
        </div>
      ))}

      {error && (
        <p className='text-xs text-destructive'>{error}</p>
      )}

      <Link
        href='/reminders'
        className='text-xs text-muted-foreground hover:text-foreground transition-colors self-start'
      >
        Manage reminders →
      </Link>
    </div>
  )
}
