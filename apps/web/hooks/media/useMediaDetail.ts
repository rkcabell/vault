'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LoadState,
  MediaDetail,
  MediaDocument,
  MediaDetailResponse,
  MediaMetadata,
  DownloadResponse
} from '@/lib/media/types'
import { readErrorMessage } from '@/lib/media/utils'
import { apiFetch } from '@/lib/apiFetch'

export function useMediaDetail (id: string) {
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [media, setMedia] = useState<MediaDetail | null>(null)
  const [document, setDocument] = useState<MediaDocument | null>(null)
  const [metadata, setMetadata] = useState<MediaMetadata | null>(null)
  const [autoTags, setAutoTags] = useState<string[]>([])
  const [localPath, setLocalPath] = useState<string | null>(null)
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const refreshModeRef = useRef<'full' | 'silent'>('full')

  const refresh = useCallback((opts?: { silent?: boolean }) => {
    refreshModeRef.current = opts?.silent ? 'silent' : 'full'
    setReloadKey(v => v + 1)
  }, [])
  const clearError = useCallback(() => setErrorMessage(null), [])

  useEffect(() => {
    const controller = new AbortController()

    const load = async () => {
      const isSilent = refreshModeRef.current === 'silent'
      refreshModeRef.current = 'full'

      if (!isSilent) {
        setLoadState('loading')
        setErrorMessage(null)
        setDownloadUrl(null)
        setThumbnailUrl(null)
        setDocument(null)
        setMetadata(null)
        setAutoTags([])
      }

      try {
        const res = await apiFetch(`/api/media/${id}`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal
        })

        if (controller.signal.aborted) return

        if (res.status === 401 || res.status === 403) {
          setLoadState('unauthorized')
          return
        }
        if (res.status === 404) {
          setLoadState('not-found')
          return
        }
        if (!res.ok) {
          const msg = await readErrorMessage(res, 'Unable to load media.')
          if (controller.signal.aborted) return
          if (!isSilent) {
            setErrorMessage(msg)
            setLoadState('error')
          }
          return
        }

        const data = (await res.json()) as MediaDetailResponse | null
        if (controller.signal.aborted) return
        if (!data?.media?.id) {
          setLoadState('not-found')
          return
        }

        setMedia(data.media)
        setDocument(data.document ?? null)
        setMetadata(data.metadata ?? null)
        setAutoTags(data.autoTags ?? [])
        setLocalPath(data.localPath ?? null)
        setThumbnailUrl(
          data.media.thumbState === 'READY'
            ? `/api/media/${id}/thumbnail?v=${encodeURIComponent(data.media.updatedAt)}`
            : null
        )
        setLoadState('ready')
      } catch (err) {
        if (controller.signal.aborted) return
        const message =
          err instanceof Error ? err.message : 'Unable to load media.'
        if (!isSilent) {
          setErrorMessage(message)
          setLoadState('error')
        }
      }
    }

    void load()
    return () => controller.abort()
  }, [id, reloadKey])

  const fetchDownloadUrl = useCallback(
    async (force = false) => {
      if (downloadUrl && !force) return downloadUrl

      const res = await apiFetch(`/api/media/${id}/download`, {
        method: 'GET',
        credentials: 'include'
      })

      if (!res.ok) {
        const msg = await readErrorMessage(
          res,
          'Unable to generate download link.'
        )
        throw new Error(msg)
      }

      const data = (await res.json()) as DownloadResponse | null
      if (!data?.url) throw new Error('Download link missing.')

      setDownloadUrl(data.url)
      return data.url
    },
    [id, downloadUrl]
  )

  const updateTitle = useCallback(
    async (nextTitle: string) => {
      const res = await apiFetch(`/api/media/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ title: nextTitle })
      })

      if (!res.ok) {
        const msg = await readErrorMessage(res, 'Unable to update title.')
        throw new Error(msg)
      }

      const data = (await res.json()) as MediaDetailResponse | null
      if (data?.media?.id) {
        setMedia(data.media)
      } else {
        setMedia(prev => (prev ? { ...prev, title: nextTitle } : prev))
      }
    },
    [id]
  )

  const updateTags = useCallback(
    async (tags: string[], signal?: AbortSignal) => {
      const res = await apiFetch(`/api/media/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        signal,
        body: JSON.stringify({ tags })
      })

      if (!res.ok) {
        const msg = await readErrorMessage(res, 'Unable to update tags.')
        throw new Error(msg)
      }

      const data = (await res.json()) as MediaDetailResponse | null
      if (data?.media?.id) {
        setMedia(data.media)
      } else {
        setMedia(prev => (prev ? { ...prev, tags } : prev))
      }
    },
    [id]
  )

  return {
    loadState,
    media,
    setMedia,
    document,
    metadata,
    autoTags,
    localPath,
    thumbnailUrl,
    downloadUrl,
    errorMessage,
    setErrorMessage,
    refresh,
    clearError,
    fetchDownloadUrl,
    updateTitle,
    updateTags
  }
}
