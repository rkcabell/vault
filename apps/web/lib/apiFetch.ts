// apps/web/lib/apiFetch.ts
//
// Silent session renewal for the browser. Access tokens are short-lived (15m)
// httpOnly cookies; the browser can't read or refresh them directly. This module
// drives renewal two ways:
//   - reactive:   apiFetch() retries once through /api/auth/refresh on a 401.
//   - proactive:  AuthContext calls refreshSession() on a timer and on focus.
// Eviction (a tokenVersion bump from an admin password reset) makes /refresh 401,
// which clears the cookies server-side and bounces the user to /auth.

// Single-flight: concurrent 401s (or a timer firing during a request) share one
// in-flight refresh instead of stampeding the endpoint.
let inflight: Promise<boolean> | null = null;

// Guard so a failed refresh redirects to /auth exactly once.
let redirecting = false;

/**
 * Mint a fresh access (and refresh) cookie from the current refresh cookie.
 * Resolves true on success, false when the session can no longer be renewed
 * (expired or evicted). Safe to call concurrently — callers share one request.
 */
export function refreshSession(): Promise<boolean> {
  if (!inflight) {
    inflight = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
        });
        return res.ok;
      } catch {
        // Network error (e.g. API restarting) — treat as "can't renew right now"
        // without evicting; the caller decides whether to retry or log out.
        return false;
      }
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

function redirectToAuth() {
  if (typeof window === 'undefined' || redirecting) return;
  // Already on the auth page (e.g. a bootstrap /api/init probe for a logged-out
  // user) — don't reload it into a loop.
  if (window.location.pathname.startsWith('/auth')) return;
  redirecting = true;
  window.location.assign('/auth');
}

/**
 * fetch wrapper that transparently renews the session on a 401 and retries once.
 * Always sends cookies. Drop-in for `fetch(url, { credentials: 'include' })`.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const opts: RequestInit = { ...init, credentials: 'include' };

  const res = await fetch(input, opts);
  if (res.status !== 401) return res;

  const renewed = await refreshSession();
  if (!renewed) {
    redirectToAuth();
    return res; // hand back the original 401 for callers mid-redirect
  }

  // Retry once with the freshly minted access cookie. Note: this re-sends
  // init.body, which is fine for our string/JSON bodies but would not work for
  // a one-shot ReadableStream body (we have none).
  return fetch(input, opts);
}
