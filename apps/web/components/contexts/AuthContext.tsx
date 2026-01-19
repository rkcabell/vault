//File: apps/web/components/contexts/AuthContext.tsx

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useRouter } from 'next/navigation';

interface User {
  id: string;
  email: string;
  name?: string;
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
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const router = useRouter();

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch (error) {
      console.error('Logout failed:', error);
    } finally {
      setUser(null);
      setStatus('unauthenticated');
      router.push('/auth');
    }
  }, [router]);

  const refresh = useCallback(async () => {
    setStatus('loading');
    try {
      const response = await fetch('/api/auth/me', { credentials: 'include' });

      if (response.ok) {
        const userData = await response.json();
        const nextUser = userData?.user ?? userData;
        if (nextUser) {
          setUser({ ...nextUser });
          setStatus('authenticated');
          return;
        }
        await logout();
        return;
      }

      if ([401, 404, 500].includes(response.status)) {
        await logout();
        return;
      }

      setUser(null);
      setStatus('unauthenticated');
    } catch (error) {
      console.error('Auth refresh failed:', error);
      setUser(null);
      setStatus('unauthenticated');
    }
  }, [logout]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const handleFocus = () => {
      if (status !== 'authenticated') void refresh();
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [status, refresh]);

  const replaceUser = (nextUser: User | null) => {
    setUser(nextUser ? { ...nextUser } : null);
    if (!nextUser) {
      setStatus('unauthenticated');
    }
  };

  return (
    <AuthContext.Provider value={{ user, status, logout, refresh, setUser: replaceUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
