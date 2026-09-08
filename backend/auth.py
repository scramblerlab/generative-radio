"""Authentication: password hashing, session tokens, and FastAPI dependencies.

Two transports, one identity:

  * **Web** is same-origin with the API (the Cloudflare tunnel points at the Vite
    preview server, which proxies /api and /ws to this process), so the browser
    carries an httpOnly `auth_token` cookie it can never read from JavaScript.
  * **Mobile** cannot rely on a cookie jar, so it sends `Authorization: Bearer`.

`extract_token_http` / `extract_token_ws` collapse both into one token string, so
a single `Depends(get_current_user)` covers every client.

Configuration is fail-closed, not fail-fast: a missing JWT_SECRET logs loudly and
disables auth, but does not take the radio down for a config typo.
"""

import base64
import hashlib
import hmac
import logging
import os
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import HTTPException, Request, WebSocket

logger = logging.getLogger(__name__)

COOKIE_NAME = "auth_token"
_ALGORITHM = "HS256"
_LEEWAY_S = 60  # clock-skew tolerance on expiry

# scrypt parameters. n=2^15 costs ~100 ms on Apple Silicon — deliberately slow,
# which is why every call must go through asyncio.to_thread.
_SCRYPT_N = 2 ** 15
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32
_SALT_BYTES = 16


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


# ------------------------------------------------------------------ #
# Configuration
# ------------------------------------------------------------------ #

def jwt_secret() -> str:
    """Read at call time, not import time, so tests can point it elsewhere."""
    return os.getenv("JWT_SECRET", "")


def invite_code() -> str:
    return os.getenv("INVITE_CODE", "")


def expire_days() -> int:
    try:
        return int(os.getenv("JWT_EXPIRE_DAYS", "30"))
    except ValueError:
        return 30


def cookie_secure() -> bool:
    # Safari refuses Secure cookies on http://localhost, so dev sets this to 0.
    return os.getenv("COOKIE_SECURE", "1") != "0"


def is_configured() -> bool:
    return bool(jwt_secret()) and bool(invite_code())


def config_status() -> str:
    """One-line summary for the startup banner."""
    if is_configured():
        return f"configured (tokens valid {expire_days()}d, secure cookies {'on' if cookie_secure() else 'OFF (dev)'})"
    missing = [n for n, v in (("JWT_SECRET", jwt_secret()), ("INVITE_CODE", invite_code())) if not v]
    return f"NOT CONFIGURED — missing {', '.join(missing)} (login and signup will return 503)"


# ------------------------------------------------------------------ #
# Identity
# ------------------------------------------------------------------ #

@dataclass(frozen=True, slots=True)
class AuthUser:
    id: str
    email: str
    nickname: str


# ------------------------------------------------------------------ #
# Password hashing
# ------------------------------------------------------------------ #

def hash_password(plain: str) -> str:
    """Return "scrypt$n$r$p$salt$key". BLOCKING — call via asyncio.to_thread."""
    salt = secrets.token_bytes(_SALT_BYTES)
    key = hashlib.scrypt(
        plain.encode("utf-8"), salt=salt,
        n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=_SCRYPT_DKLEN,
        maxmem=_SCRYPT_N * _SCRYPT_R * 256,
    )
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${_b64(salt)}${_b64(key)}"


def verify_password(plain: str, stored: str) -> bool:
    """Constant-time verify. BLOCKING — call via asyncio.to_thread.

    Parameters are read back out of the stored string so old hashes stay valid
    if the cost factors are raised later.
    """
    try:
        scheme, n, r, p, salt_b64, key_b64 = stored.split("$")
        if scheme != "scrypt":
            return False
        n, r, p = int(n), int(r), int(p)
        salt, expected = _unb64(salt_b64), _unb64(key_b64)
    except (ValueError, TypeError):
        logger.warning("[auth] Malformed password hash in store")
        return False
    actual = hashlib.scrypt(
        plain.encode("utf-8"), salt=salt,
        n=n, r=r, p=p, dklen=len(expected),
        maxmem=n * r * 256,
    )
    return hmac.compare_digest(actual, expected)


# ------------------------------------------------------------------ #
# Session tokens
# ------------------------------------------------------------------ #

def create_access_token(user: AuthUser) -> tuple[str, datetime]:
    """Issue an HS256 session token. Returns (token, expires_at)."""
    secret = jwt_secret()
    if not secret:
        raise HTTPException(status_code=503, detail="Auth is not configured")
    now = datetime.now(timezone.utc)
    exp = now + timedelta(days=expire_days())
    token = jwt.encode(
        {"sub": user.id, "email": user.email, "nick": user.nickname,
         "iat": now, "exp": exp},
        secret,
        algorithm=_ALGORITHM,
    )
    return token, exp


def verify_token(token: str) -> AuthUser:
    """Decode and validate a session token, or raise 401."""
    secret = jwt_secret()
    if not secret:
        raise HTTPException(status_code=401, detail="Auth is not configured")
    try:
        payload = jwt.decode(
            token, secret,
            algorithms=[_ALGORITHM],          # pinned: never trust the token's own alg
            leeway=_LEEWAY_S,
            options={"require": ["sub", "exp"]},
        )
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user_id = payload.get("sub")
    nickname = payload.get("nick") or ""
    if not user_id or not nickname:
        raise HTTPException(status_code=401, detail="Invalid token claims")
    return AuthUser(id=user_id, email=payload.get("email") or "", nickname=nickname)


# ------------------------------------------------------------------ #
# Transport-agnostic extraction
# ------------------------------------------------------------------ #

def _from_authorization(header: str | None) -> str | None:
    if not header:
        return None
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer":
        return None
    return value.strip() or None


def extract_token_http(request: Request) -> str | None:
    """Authorization: Bearer <t>, then the auth_token cookie. First match wins."""
    return _from_authorization(request.headers.get("authorization")) or \
        (request.cookies.get(COOKIE_NAME) or None)


def extract_token_ws(ws: WebSocket) -> str | None:
    """Authorization header, then cookie, then ?token= (React Native's only option)."""
    return _from_authorization(ws.headers.get("authorization")) or \
        (ws.cookies.get(COOKIE_NAME) or None) or \
        (ws.query_params.get("token") or None)


# ------------------------------------------------------------------ #
# FastAPI dependencies
# ------------------------------------------------------------------ #

async def get_current_user(request: Request) -> AuthUser:
    """Require a signed-in caller. Claims-only — no database round trip.

    /api/library/audio/{id} is hit up to 500 times during one offline download,
    so a per-request DB lookup would be a real cost for no security gain: the
    token is already unforgeable, and its 30-day life is the accepted blast
    radius (see the plan's "no password reset in scope" decision).
    """
    token = extract_token_http(request)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return verify_token(token)


async def get_optional_user(request: Request) -> AuthUser | None:
    """Like get_current_user, but returns None for anonymous callers."""
    token = extract_token_http(request)
    if not token:
        return None
    try:
        return verify_token(token)
    except HTTPException:
        return None
