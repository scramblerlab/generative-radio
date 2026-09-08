/** Shapes exchanged with /api/auth/*. Mirrors backend/routers/auth.py. */

export interface AuthUser {
  id: string;
  email: string;
  nickname: string;   // also the DJ display name
}

export interface SignupRequest {
  email: string;
  password: string;
  nickname: string;
  inviteCode: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthSuccess {
  user: AuthUser;
  expiresAt: string;   // ISO-8601
  /** Present only for clients that sent `X-Auth-Transport: bearer` (mobile).
   *  Browsers deliberately never receive this — they use the httpOnly cookie. */
  token?: string;
}

export interface VerifyResponse {
  valid: true;
  user: AuthUser;
}

/** Thrown by the auth client for any non-2xx response. */
export class AuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }

  /** True when the server rejected the credentials rather than failing. */
  get isCredentialError(): boolean {
    return this.status === 401 || this.status === 403 || this.status === 409;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  get isUnconfigured(): boolean {
    return this.status === 503;
  }
}
