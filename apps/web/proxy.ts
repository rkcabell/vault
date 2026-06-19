// File: apps\web\proxy.ts
import { NextResponse, type NextRequest } from 'next/server'

// Public routes that do NOT require auth:
const PUBLIC_PREFIXES = [
  '/auth',
  '/_next',
  '/favicon',
  '/icons',
  '/images'
]

export function proxy (req: NextRequest) {
  const { pathname } = req.nextUrl

  // Gate on the refresh token, not the access token: the access token is
  // short-lived (15m) and lapses during normal use, but a returning user with a
  // valid 7d refresh cookie should be let in — the client silently renews the
  // access token. Real token validity is enforced by the API on every request.
  const token = req.cookies.get('refresh_token')?.value ?? ''

  // Always allow landing page
  if (pathname === '/') return NextResponse.next()

  // Always allow api routes
  if (pathname.startsWith('/api')) return NextResponse.next()

  // Allow public prefixes
  if (PUBLIC_PREFIXES.some(p => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  // Gate everything else
  if (!token) {
    const url = req.nextUrl.clone()
    url.pathname = '/auth'
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    // deny image extension requests
    '/((?!_next/static|_next/image|.*\\.(?:png|jpg|jpeg|gif|webp|svg)).*)'
  ]
}
