/**
 * Signup / login field validation.
 *
 * ⚠ These rules mirror backend/routers/auth.py. Change one, change the other.
 *    The server is authoritative — this exists so the user sees an error before
 *    a round trip, not as a security boundary.
 */

export const EMAIL_MAX = 254;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 24;
// Mirrors Python's /^[\w \-.]+$/ under re.UNICODE, where \w is "alphanumeric in
// any script, plus underscore". JavaScript's \w is ASCII-only, so the classes
// are spelled out — otherwise Japanese nicknames would be rejected here and
// accepted by the server.
export const NICKNAME_RE = /^[\p{L}\p{N}_ \-.]+$/u;
// "Auto" is the pseudo-DJ the backend uses when it auto-starts a session with
// no human DJ, so a user owning that nickname would be indistinguishable.
export const RESERVED_NICKNAMES = ['auto'];

/** Trim + lowercase, matching the server's normalization before storage. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function normalizeNickname(raw: string): string {
  return raw.trim();
}

/** Return an error message, or null when the value is acceptable. */
export function validateEmail(raw: string): string | null {
  const email = normalizeEmail(raw);
  if (!email) return 'Email is required';
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return 'Enter a valid email address';
  return null;
}

export function validatePassword(raw: string): string | null {
  if (!raw) return 'Password is required';
  if (raw.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (raw.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters`;
  return null;
}

export function validateNickname(raw: string): string | null {
  const nickname = normalizeNickname(raw);
  if (!nickname) return 'Nickname is required';
  if (nickname.length < NICKNAME_MIN) return `Nickname must be at least ${NICKNAME_MIN} characters`;
  if (nickname.length > NICKNAME_MAX) return `Nickname must be at most ${NICKNAME_MAX} characters`;
  if (!NICKNAME_RE.test(nickname)) {
    return 'Nickname may contain letters, numbers, spaces, hyphens, dots and underscores';
  }
  if (RESERVED_NICKNAMES.includes(nickname.toLowerCase())) return 'That nickname is reserved';
  return null;
}
