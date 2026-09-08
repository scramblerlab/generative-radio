/**
 * Framework-agnostic client for /api/auth/*.
 *
 * The two apps differ only in configuration, not in logic:
 *
 *   web    — baseUrl '' (same origin), no getToken. The browser carries the
 *            httpOnly cookie automatically; `credentials: 'include'` makes that
 *            explicit and keeps working if the origins ever diverge.
 *   mobile — baseUrl BACKEND_URL, getToken reads expo-secure-store. Setting
 *            getToken also opts into `X-Auth-Transport: bearer`, which is what
 *            makes the server return a token in the response body.
 *
 * Uses the global fetch, which exists in both browsers and React Native 0.83.
 */

import { AuthError } from './auth';
import type { AuthSuccess, AuthUser, LoginRequest, SignupRequest } from './auth';

export interface AuthClientOptions {
  /** '' for same-origin web; an absolute origin for mobile. */
  baseUrl: string;
  /** Supplying this switches the client to bearer transport. */
  getToken?: () => string | null;
}

export interface AuthClient {
  signup(body: SignupRequest): Promise<AuthSuccess>;
  login(body: LoginRequest): Promise<AuthSuccess>;
  logout(): Promise<void>;
  /** Resolves to the current user, or null when not signed in. */
  verify(): Promise<AuthUser | null>;
}

/** FastAPI returns {"detail": "..."} for HTTPException. */
async function errorFrom(res: Response): Promise<AuthError> {
  let message = `Request failed (${res.status})`;
  try {
    const body = await res.json();
    if (typeof body?.detail === 'string') message = body.detail;
  } catch {
    // Non-JSON body (a proxy error page, say) — keep the generic message.
  }
  return new AuthError(res.status, message);
}

export function createAuthClient({ baseUrl, getToken }: AuthClientOptions): AuthClient {
  const usesBearer = typeof getToken === 'function';

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (usesBearer) {
      // Tells the server to include a token in the response body. Browsers
      // never send this, so they are never handed a token to leak.
      headers['X-Auth-Transport'] = 'bearer';
      const token = getToken!();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      credentials: 'include',
      ...init,
      headers,
    });
  }

  async function post(path: string, body?: unknown): Promise<AuthSuccess> {
    const res = await request(path, body === undefined ? {} : { body: JSON.stringify(body) });
    if (!res.ok) throw await errorFrom(res);
    return res.json() as Promise<AuthSuccess>;
  }

  return {
    signup: (body) => post('/api/auth/signup', body),
    login: (body) => post('/api/auth/login', body),

    async logout() {
      // Best-effort: the server clears the cookie, but a client that is offline
      // must still be able to sign out locally.
      try {
        await request('/api/auth/logout');
      } catch {
        // ignored on purpose
      }
    },

    async verify() {
      const res = await request('/api/auth/verify');
      if (res.status === 401) return null;
      if (!res.ok) throw await errorFrom(res);
      const body = await res.json() as { user: AuthUser };
      return body.user;
    },
  };
}
