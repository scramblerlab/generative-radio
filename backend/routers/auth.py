"""Signup / login / logout / verify.

This is the project's first APIRouter, and the split is deliberate: main.py
builds the OllamaClient / ACEStepClient / RadioOrchestrator singletons at import
time, so `from main import app` in a test would try to reach Ollama. A standalone
router mounts onto a bare FastAPI() instance, which is what backend/tests does.

Signup is invite-gated (INVITE_CODE env var). There is no password reset and no
email verification — by design, since the project has no mail infrastructure.

⚠ The validation rules below are mirrored in packages/shared/src/validation.ts.
   Change one, change the other.
"""

import asyncio
import hmac
import logging
import re

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import auth as auth_module
import ratelimit
import users
from netutil import resolve_request_ip

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# ---- Validation (mirrored in packages/shared/src/validation.ts) ---- #
EMAIL_MAX = 254
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PASSWORD_MIN = 8
PASSWORD_MAX = 128
NICKNAME_MIN = 2
NICKNAME_MAX = 24
NICKNAME_RE = re.compile(r"^[\w \-.]+$", re.UNICODE)
# "Auto" is the pseudo-DJ the backend uses when it auto-starts a session with no
# human DJ (radio.py). A user owning that nickname would be indistinguishable.
RESERVED_NICKNAMES = {"auto"}


class SignupRequest(BaseModel):
    email: str
    password: str
    nickname: str
    inviteCode: str


class LoginRequest(BaseModel):
    email: str
    password: str


def _require_configured() -> None:
    if not auth_module.is_configured():
        logger.error("[auth] Request rejected — auth is not configured")
        raise HTTPException(status_code=503, detail="Auth is not configured on this server")


def _normalize_email(raw: str) -> str:
    email = raw.strip().lower()
    if len(email) > EMAIL_MAX or not EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="Enter a valid email address")
    return email


def _validate_password(raw: str) -> str:
    if not (PASSWORD_MIN <= len(raw) <= PASSWORD_MAX):
        raise HTTPException(
            status_code=400,
            detail=f"Password must be between {PASSWORD_MIN} and {PASSWORD_MAX} characters",
        )
    return raw


def _normalize_nickname(raw: str) -> str:
    nickname = raw.strip()
    if not (NICKNAME_MIN <= len(nickname) <= NICKNAME_MAX):
        raise HTTPException(
            status_code=400,
            detail=f"Nickname must be between {NICKNAME_MIN} and {NICKNAME_MAX} characters",
        )
    if not NICKNAME_RE.match(nickname):
        raise HTTPException(
            status_code=400,
            detail="Nickname may contain letters, numbers, spaces, hyphens, dots and underscores",
        )
    if nickname.lower() in RESERVED_NICKNAMES:
        raise HTTPException(status_code=400, detail="That nickname is reserved")
    return nickname


def _wants_bearer(request: Request) -> bool:
    """Mobile opts in to a token in the response body; browsers never do."""
    return request.headers.get("x-auth-transport", "").lower() == "bearer"


def _auth_response(
    request: Request, user: auth_module.AuthUser, status_code: int
) -> JSONResponse:
    """Issue a token, set the cookie, and shape the body for this transport."""
    token, exp = auth_module.create_access_token(user)
    body = {
        "user": {"id": user.id, "email": user.email, "nickname": user.nickname},
        "expiresAt": exp.isoformat(),
    }
    if _wants_bearer(request):
        # Only handed to clients that asked for it — a browser has no business
        # holding a token it could leak through XSS.
        body["token"] = token
    response = JSONResponse(body, status_code=status_code)
    response.set_cookie(
        key=auth_module.COOKIE_NAME,
        value=token,
        httponly=True,
        # "lax" not "strict": strict drops the cookie on any cross-site
        # navigation into the app (a link from a chat client), which reads to the
        # user as a silent logout. Every state-changing call is a same-origin
        # POST or WebSocket, so lax is sufficient here.
        samesite="lax",
        secure=auth_module.cookie_secure(),
        max_age=auth_module.expire_days() * 86_400,
        path="/",
    )
    return response


@router.post("/signup", status_code=201)
async def signup(request: Request, body: SignupRequest):
    _require_configured()
    ip = resolve_request_ip(request)
    ratelimit.check("signup", ip, limit=3, window_s=60)
    ratelimit.check("signup-daily", ip, limit=20, window_s=86_400)

    # Checked before any DB work so this endpoint is not an invite-code oracle.
    if not hmac.compare_digest(body.inviteCode.strip(), auth_module.invite_code()):
        logger.warning(f"[auth] Signup rejected — bad invite code from {ip}")
        raise HTTPException(status_code=403, detail="Invalid invite code")

    email = _normalize_email(body.email)
    password = _validate_password(body.password)
    nickname = _normalize_nickname(body.nickname)

    password_hash = await asyncio.to_thread(auth_module.hash_password, password)
    try:
        record = await asyncio.to_thread(users.create_user, email, nickname, password_hash)
    except users.EmailTakenError:
        raise HTTPException(status_code=409, detail="That email address is already registered")
    except users.NicknameTakenError:
        raise HTTPException(status_code=409, detail="That nickname is already taken")

    logger.info(f"[auth] Signup: {record.id} nickname={nickname!r} from {ip}")
    user = auth_module.AuthUser(id=record.id, email=record.email, nickname=record.nickname)
    return _auth_response(request, user, status_code=201)


@router.post("/login")
async def login(request: Request, body: LoginRequest):
    _require_configured()
    ip = resolve_request_ip(request)
    email = body.email.strip().lower()
    ratelimit.check("login-ip", ip, limit=5, window_s=60)
    # Also keyed on the account, so credential stuffing rotated across IPs is
    # slowed down rather than only per-source throttled.
    ratelimit.check("login-email", email, limit=10, window_s=900)

    record = await asyncio.to_thread(users.get_by_email, email)
    if record is None:
        # Burn comparable time so a missing account is not distinguishable by
        # response latency from a wrong password.
        await asyncio.to_thread(auth_module.hash_password, body.password)
        raise HTTPException(status_code=401, detail="Incorrect email or password")

    ok = await asyncio.to_thread(auth_module.verify_password, body.password, record.password_hash)
    if not ok:
        logger.warning(f"[auth] Failed login for {email!r} from {ip}")
        raise HTTPException(status_code=401, detail="Incorrect email or password")
    if record.disabled:
        raise HTTPException(status_code=403, detail="This account has been disabled")

    await asyncio.to_thread(users.touch_last_login, record.id)
    logger.info(f"[auth] Login: {record.id} nickname={record.nickname!r} from {ip}")
    user = auth_module.AuthUser(id=record.id, email=record.email, nickname=record.nickname)
    return _auth_response(request, user, status_code=200)


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie(auth_module.COOKIE_NAME, path="/")
    return {"ok": True}


@router.post("/verify")
async def verify(request: Request):
    """Session restore. The web app calls this on mount; mobile calls it after
    reading its stored token, to detect a token invalidated server-side."""
    ratelimit.check("verify", resolve_request_ip(request), limit=30, window_s=60)
    token = auth_module.extract_token_http(request)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = auth_module.verify_token(token)
    return {
        "valid": True,
        "user": {"id": user.id, "email": user.email, "nickname": user.nickname},
    }
