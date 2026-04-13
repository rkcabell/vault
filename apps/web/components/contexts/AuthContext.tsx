// File: apps/web/components/contexts/AuthContext.tsx

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { useAppInit, resetAppInit } from '@/hooks/useAppInit';

interface User {
  id: string;
  email: string;
  name?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
}

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextType {
  user: User | null;
  status: AuthStatus;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setUser: (user: User | null) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const router = useRouter();
  const { data: initData, isLoaded: initLoaded, unauthenticated: initUnauthenticated } = useAppInit();

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch (error) {
      console.error('Logout failed:', error);
    } finally {
      resetAppInit();
      setUserState(null);
      setStatus('unauthenticated');
      router.push('/auth');
    }
  }, [router]);

  // Fallback: hit /api/auth/me directly (used for focus re-auth and init failures).
  const refresh = useCallback(async () => {
    // Only show the loading state on the initial auth check, not on background
    // re-validations (e.g. window focus). Flipping to 'loading' while already
    // authenticated causes AuthGuard to unmount the page, resetting all state.
    setStatus(prev => prev === 'authenticated' ? 'authenticated' : 'loading');
    try {
      const response = await fetch('/api/auth/me', { credentials: 'include' });

      if (response.ok) {
        const userData = await response.json();
        const nextUser = userData?.user ?? userData;

        if (nextUser) {
          setUserState({ ...nextUser });
          setStatus('authenticated');
          return;
        }

        await logout();
        return;
      }

      if (response.status === 401) {
        await logout();
        return;
      }

      // 5xx / proxy errors (e.g. 502 from Next.js when the API is restarting).
      // The Next.js rewrite proxy returns a real HTTP response (not a thrown error),
      // so the catch block never fires for these. Treat them like network errors:
      // preserve auth state for already-authenticated users rather than evicting them.
      if (response.status >= 500) {
        console.error('Auth refresh got server error:', response.status);
        setStatus(prev => prev === 'authenticated' ? 'authenticated' : 'unauthenticated');
        return;
      }

      setUserState(null);
      setStatus('unauthenticated');
    } catch (error) {
      // Network error (e.g. server restarting). Don't evict an already-authenticated
      // user — their session cookie is still valid and will work once the API is back.
      console.error('Auth refresh failed:', error);
      setStatus(prev => prev === 'authenticated' ? 'authenticated' : 'unauthenticated');
    }
  }, [logout]);

  // Hydrate user from the batched init response — no separate /api/auth/me on mount.
  useEffect(() => {
    if (!initLoaded) return;
    if (initData?.user) {
      setUserState(initData.user as User);
      setStatus('authenticated');
    } else if (initData !== null || initUnauthenticated) {
      // Init succeeded but returned no user, or explicitly 401 → unauthenticated.
      setUserState(null);
      setStatus('unauthenticated');
    } else {
      // Init fetch failed entirely → fall back to direct auth check.
      void refresh();
    }
  }, [initLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-validate session on window focus (only when already authenticated).
  useEffect(() => {
    const handleFocus = () => {
      if (status === 'authenticated') void refresh();
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [status, refresh]);

  const replaceUser = useCallback((nextUser: User | null) => {
    setUserState(nextUser ? { ...nextUser } : null);
    if (!nextUser) setStatus('unauthenticated');
  }, []);

  const value = useMemo<AuthContextType>(
    () => ({ user, status, logout, refresh, setUser: replaceUser }),
    [user, status, logout, refresh, replaceUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
