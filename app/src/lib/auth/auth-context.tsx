'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

export interface AuthUser {
  userId: string;
  email: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, inviteCode: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const AUTH_SYNC_EVENT_KEY = 'doppelspotter:auth-sync';

export function broadcastAuthSyncEvent(type: 'signed-in' | 'signed-out' | 'password-changed') {
  if (typeof window === 'undefined') return;

  window.localStorage.setItem(
    AUTH_SYNC_EVENT_KEY,
    JSON.stringify({ type, at: Date.now() }),
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshSession = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!res.ok) {
        setUser(null);
        return;
      }

      const data = await res.json();
      if (data?.userId) {
        setUser({ userId: data.userId, email: data.email });
        return;
      }

      setUser(null);
    } catch {
      setUser(null);
    }
  }, []);

  // Check current session on mount
  useEffect(() => {
    refreshSession().finally(() => setLoading(false));
  }, [refreshSession]);

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key !== AUTH_SYNC_EVENT_KEY || !event.newValue) return;
      void refreshSession();
    }

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [refreshSession]);

  async function signIn(email: string, password: string) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? 'Sign in failed');
    }
    const data = await res.json();
    setUser({ userId: data.userId, email: data.email });
    broadcastAuthSyncEvent('signed-in');
  }

  async function signUp(email: string, password: string, inviteCode: string) {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email, password, inviteCode }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? 'Sign up failed');
    }
    // No session is issued at signup — the user must verify their email first
  }

  async function signOut() {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
    setUser(null);
    broadcastAuthSyncEvent('signed-out');
  }

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signUp, signOut, refreshSession }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
