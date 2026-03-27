'use client'

import { useEffect, useState } from 'react'

export function useQuery<T> (key: unknown, fn: () => Promise<T>) {
  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(undefined)

  const keyString = JSON.stringify(key)

  useEffect(() => {
    let alive = true
    setLoading(true)

    fn()
      .then(d => {
        if (alive) setData(d)
      })
      .catch(e => {
        if (alive) setError(e)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })

    return () => {
      alive = false
    }
  }, [keyString]) // eslint-disable-line react-hooks/exhaustive-deps -- fn is intentionally excluded; callers encode all query params into key

  return { data, loading, error }
}
