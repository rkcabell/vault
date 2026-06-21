'use client'

import { useSyncExternalStore } from 'react'
import { apiFetch } from '@/lib/apiFetch'

/**
 * Server capabilities that the UI conditionally renders against. Fetched once
 * from GET /api/server/status and shared across all consumers via a
 * module-level singleton (same pattern as usePreferences).
 */
export type ServerCapabilities = {
  /** Server can open a native file manager on the host (local/single-user only). */
  localExplorer: boolean
}

let caps: ServerCapabilities | null = null
let loaded = false
let fetching = false
const listeners = new Set<() => void>()

function notify () {
  for (const fn of listeners) fn()
}

function fetchOnce () {
  if (loaded || fetching) return
  fetching = true
  apiFetch('/api/server/status', { credentials: 'include' })
    .then(r => (r.ok ? r.json() : null))
    .then((data: { localExplorer?: boolean } | null) => {
      // Fail open: assume reveal is allowed unless the server says otherwise.
      caps = { localExplorer: data?.localExplorer ?? true }
    })
    .catch(() => {
      // Unreachable status endpoint → assume local install where the button works.
      caps = { localExplorer: true }
    })
    .finally(() => {
      loaded = true
      fetching = false
      notify()
    })
}

function subscribe (fn: () => void) {
  listeners.add(fn)
  fetchOnce()
  return () => listeners.delete(fn)
}

function getSnapshot () {
  return caps
}

function getServerSnapshot (): ServerCapabilities | null {
  return null
}

/** Returns `{ capabilities, isLoaded }`; capabilities is null until the fetch resolves. */
export function useServerStatus () {
  const capabilities = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return { capabilities, isLoaded: loaded }
}
