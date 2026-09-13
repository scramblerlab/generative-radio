import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { AuthUser, createAuthClient } from '@radio/shared';
import { BACKEND_URL } from '../config';

const TOKEN_KEY = 'auth.token';
const USER_KEY  = 'auth.user';

export interface UseAuthReturn {
  user: AuthUser | null;
  /** The bearer JWT, or null. Passed to wsUrl() and the library fetches. */
  token: string | null;
  isAuthenticated: boolean;
  /** True until SecureStore has been read. Guards the UI against flashing
   *  "signed out" for a user who is in fact signed in. */
  isLoading: boolean;
  /** Bumped on every sign-in and sign-out. useRadio watches it and reconnects
   *  the WebSocket so the server re-reads identity — without this the DJ button
   *  would not appear until the app was restarted. */
  authVersion: number;
  signup(email: string, password: string, nickname: string, inviteCode: string): Promise<void>;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

/**
 * Mobile session container.
 *
 * Deliberately a plain hook rather than a Context: App.tsx is small and already
 * threads `radio` down to AppNavigator, so one more prop costs less than a
 * provider.
 *
 * It also does not mirror the web's AuthContext, which restores a session with
 * a `verify()` round trip. Mobile hydrates from SecureStore instead: the app
 * must be able to start signed-in with no network at all (offline mode), and
 * the token is self-describing anyway. A token that has expired is caught the
 * first time the server rejects it, not on launch.
 */
export function useAuth(): UseAuthReturn {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [authVersion, setAuthVersion] = useState(0);

  // createAuthClient wants a *synchronous* getToken, and React state lags a
  // render behind, so the ref is the authoritative copy for outgoing requests.
  const tokenRef = useRef<string | null>(null);

  const client = useMemo(
    // Supplying getToken is what switches the shared client to bearer
    // transport — the header that makes the server return a token at all.
    () => createAuthClient({ baseUrl: BACKEND_URL, getToken: () => tokenRef.current }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [storedToken, storedUser] = await Promise.all([
          SecureStore.getItemAsync(TOKEN_KEY),
          SecureStore.getItemAsync(USER_KEY),
        ]);
        if (cancelled) return;
        if (storedToken && storedUser) {
          tokenRef.current = storedToken;
          setToken(storedToken);
          setUser(JSON.parse(storedUser) as AuthUser);
          // The radio does not wait for this read — it connects anonymously on
          // mount so playback starts immediately. Restoring a session is
          // therefore an identity *change*, and must bump authVersion like a
          // sign-in does, or the socket would stay anonymous for the whole run
          // and DJ mode would never appear for a returning member.
          setAuthVersion((v) => v + 1);
        }
      } catch (err) {
        // A corrupt or unreadable keychain entry must not brick the app —
        // fall through to signed-out and let the user sign in again.
        console.error('[Auth] Session restore failed:', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /** Persist (or clear) the session and tell useRadio that identity changed. */
  const adopt = useCallback(async (next: AuthUser | null, nextToken: string | null) => {
    tokenRef.current = nextToken;
    setUser(next);
    setToken(nextToken);
    try {
      if (next && nextToken) {
        await SecureStore.setItemAsync(TOKEN_KEY, nextToken);
        await SecureStore.setItemAsync(USER_KEY, JSON.stringify(next));
      } else {
        await SecureStore.deleteItemAsync(TOKEN_KEY);
        await SecureStore.deleteItemAsync(USER_KEY);
      }
    } catch (err) {
      // In-memory state is already correct; the session just will not survive
      // a restart. Better than failing a sign-in the server accepted.
      console.error('[Auth] Persisting session failed:', err);
    }
    setAuthVersion((v) => v + 1);
  }, []);

  const signup = useCallback(async (
    email: string, password: string, nickname: string, inviteCode: string,
  ) => {
    const res = await client.signup({ email, password, nickname, inviteCode });
    await adopt(res.user, res.token ?? null);
  }, [client, adopt]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await client.login({ email, password });
    await adopt(res.user, res.token ?? null);
  }, [client, adopt]);

  const logout = useCallback(async () => {
    // Best-effort server call (the shared client swallows its own failures), so
    // signing out works with no connection — including mid-offline-playback.
    // Downloaded tracks are deliberately left on disk: they were authorized
    // when they were fetched, and deleting a file that is currently playing is
    // the same class of bug as the double-playback one.
    await client.logout();
    await adopt(null, null);
  }, [client, adopt]);

  return {
    user,
    token,
    isAuthenticated: user !== null,
    isLoading,
    authVersion,
    signup,
    login,
    logout,
  };
}
