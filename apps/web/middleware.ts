// File: middleware.ts
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

  // Dont gate API routes here (backend should auth them)
  if (pathname.startsWith("/api")) return NextResponse.next();

  const token = req.cookies.get("access_token")?.value ?? "";

  // If already logged in, keep them out of /auth (must be BEFORE PUBLIC_PREFIXES early-return)
  if (pathname === "/auth" && token) {
    const url = req.nextUrl.clone();
    url.pathname = "/media";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Allow public prefixes (auth included)
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

    // Gate everything else
  if (!token) {
    const url = req.nextUrl.clone();
    url.pathname = "/auth";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    // deny image extension requests
    '/((?!_next/static|_next/image|.*\\.(?:png|jpg|jpeg|gif|webp|svg)).*)'
  ]
}
