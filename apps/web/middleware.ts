// File: apps\web\middleware.ts
import { NextResponse, type NextRequest } from 'next/server'

// Public routes that do NOT require auth:
const PUBLIC_PREFIXES = [
  '/auth',
  '/shared',
  '/_next',
  '/favicon',
  '/icons',
  '/images'
]

export function middleware (req: NextRequest) {
  const { pathname } = req.nextUrl

  // Check for access token cookie
  const token = req.cookies.get('access_token')?.value ?? ''

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
