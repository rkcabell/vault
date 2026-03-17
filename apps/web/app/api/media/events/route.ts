import { cookies } from 'next/headers'

// Force dynamic rendering so Next.js never caches or buffers this route
export const dynamic = 'force-dynamic'

const API_BASE = process.env.API_BASE_URL ?? 'http://127.0.0.1:8000'

/**
 * Proxies the Fastify SSE endpoint to the browser.
 *
 * Next.js rewrites buffer response bodies, which breaks Server-Sent Events.
 * This route handler streams the upstream response body directly so SSE
 * events arrive immediately without buffering.
 */
export async function GET (request: Request) {
  const cookieStore = await cookies()

  const upstream = await fetch(`${API_BASE}/api/media/events`, {
    headers: {
      cookie: cookieStore.toString(),
      accept: 'text/event-stream',
      'cache-control': 'no-cache',
    },
    cache: 'no-store',
    signal: request.signal,
  })

  if (!upstream.ok || !upstream.body) {
    return new Response('Failed to connect to event stream', { status: upstream.status })
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
