import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AuthUser, createAuthClient } from '@radio/shared';

interface AuthContextValue {
  user: AuthUser | null;
  /** True until the initial session-restore call resolves. Guards against UI
   *  flashing "signed out" for a user who is in fact signed in. */
  isLoading: boolean;
  /** Bumped on every sign-in and sign-out. useRadio depends on it so the
   *  WebSocket reconnects and the server re-reads identity — without this the
   *  DJ button would not appear until the page was reloaded. */
  authVersion: number;
  signup(email: string, password: string, nickname: string, inviteCode: string): Promise<void>;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: true,
  authVersion: 0,
  signup: async () => {},
  login: async () => {},
  logout: async () => {},
});

// Same origin in dev and prod: the tunnel points at the Vite preview server,
// which proxies /api and /ws to the backend. The session cookie is httpOnly, so
// there is no token for this app to hold.
const client = createAuthClient({ baseUrl: '' });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [authVersion, setAuthVersion] = useState(0);

  // StrictMode double-invokes effects in dev; verify() is cheap but rate
  // limited, so only the first run should fire.
  const restored = useRef(false);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    client.verify()
      .then(setUser)
      .catch((err) => console.error('[Auth] Session restore failed:', err))
      .finally(() => setIsLoading(false));
  }, []);

  const adopt = useCallback((next: AuthUser | null) => {
    setUser(next);
    setAuthVersion((v) => v + 1);
  }, []);

  const signup = useCallback(async (
    email: string, password: string, nickname: string, inviteCode: string,
  ) => {
    const { user: created } = await client.signup({ email, password, nickname, inviteCode });
    adopt(created);
  }, [adopt]);

  const login = useCallback(async (email: string, password: string) => {
    const { user: signedIn } = await client.login({ email, password });
    adopt(signedIn);
  }, [adopt]);

  const logout = useCallback(async () => {
    await client.logout();
    adopt(null);
  }, [adopt]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, isLoading, authVersion, signup, login, logout }),
    [user, isLoading, authVersion, signup, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
