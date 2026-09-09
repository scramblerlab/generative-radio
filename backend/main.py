import asyncio
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import AsyncGenerator

# Configure logging before any other imports so all modules inherit this format.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse, Response
from config import OLLAMA_MODEL
from genres import GENRES, KEYWORDS, LANGUAGES
from llm import OllamaClient
from acestep_client import ACEStepClient
from radio import RadioOrchestrator
from netutil import is_local_ip as _is_local_ip, resolve_request_ip as _resolve_request_ip
import auth as auth_module
import ratelimit
import users
from auth import AuthUser, get_current_user
from routers.auth import router as auth_router
from models import ReactRequest
from warmup import run_warmup

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------ #
# Service singletons (created at module level so they're available
# to route handlers without threading through request state)
# ------------------------------------------------------------------ #

llm = OllamaClient()
acestep = ACEStepClient()
radio = RadioOrchestrator(llm=llm, acestep=acestep)

# ------------------------------------------------------------------ #
# Lifespan (startup / shutdown)
# ------------------------------------------------------------------ #

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    logger.info("=" * 60)
    logger.info("Generative Radio backend starting")
    logger.info(f"  LLM model : {OLLAMA_MODEL}")
    logger.info(f"  ACE-Step  : {acestep.base_url}")
    logger.info(f"  Library   : {radio.library.dir if radio.library.enabled else 'disabled'} ({len(radio.library)} tracks)")
    users.init_db()
    logger.info(f"  Auth      : {auth_module.config_status()}")
    logger.info(f"  Users     : {users.count_users()} registered")
    if not auth_module.is_configured():
        logger.critical(
            "[main] Auth is not configured — the radio still plays, but nobody can "
            "sign up or log in. Run ./scripts/setup.sh to generate "
            "~/.generative-radio.env, then restart."
        )
    logger.info("=" * 60)

    radio.library.start_janitor()
    warmup_task: asyncio.Task | None = None
    if os.getenv("WARMUP_ON_START", "1") == "1":
        warmup_task = asyncio.create_task(run_warmup(acestep), name="acestep-warmup")

    yield  # application runs here

    logger.info("[main] Shutting down — stopping radio and closing clients")
    if warmup_task and not warmup_task.done():
        warmup_task.cancel()
    radio.library.stop_janitor()
    await radio.stop()
    await acestep.close()
    logger.info("[main] Shutdown complete")


# ------------------------------------------------------------------ #
# App setup
# ------------------------------------------------------------------ #

app = FastAPI(title="Generative Radio", version="1.0.0", lifespan=lifespan)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Inject HTTP security headers on every response."""

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Resource-Policy"] = "same-site"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "connect-src 'self' wss: https:; "
            "font-src 'self' fonts.gstatic.com; "
            "style-src 'self' 'unsafe-inline' fonts.googleapis.com; "
            "script-src 'self'; "
            "img-src 'self' data:; "
            "frame-ancestors 'none'"
        )
        return response


app.add_middleware(SecurityHeadersMiddleware)

# The project's only APIRouter — see backend/routers/auth.py for why.
app.include_router(auth_router)

# In dev mode (ALLOW_QUICK_TUNNEL=1) also accept Cloudflare quick-tunnel origins.
# Never set this in production — start_prod.sh intentionally omits it.
_quick_tunnel_regex = (
    r"https://[a-z0-9-]+\.trycloudflare\.com"
    if os.getenv("ALLOW_QUICK_TUNNEL") == "1"
    else None
)
if os.getenv("ALLOW_QUICK_TUNNEL") == "1":
    logger.info("[main] CORS: quick-tunnel origins enabled (dev mode)")
else:
    logger.info("[main] CORS: quick-tunnel origins disabled (production mode)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://radio.scrambler-lab.com",
    ],
    allow_origin_regex=_quick_tunnel_regex,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ------------------------------------------------------------------ #
# REST Endpoints
# ------------------------------------------------------------------ #

@app.get("/api/genres")
async def get_genres():
    """Return available genre and keyword lists for the frontend selector."""
    logger.debug("[main] GET /api/genres")
    return {"genres": GENRES, "keywords": KEYWORDS, "languages": LANGUAGES}


@app.get("/api/advanced-options")
async def get_advanced_options():
    """Return last-used advanced options so any browser connecting gets the same defaults."""
    logger.debug("[main] GET /api/advanced-options")
    return radio.saved_advanced_options


@app.get("/api/radio/status")
async def get_status():
    """Return current radio state and track info."""
    logger.debug("[main] GET /api/radio/status")
    track = None
    if radio.current_track:
        track = radio._make_track_dict(radio.current_track)
    return {
        "state": radio.state.value,
        "currentTrack": track,
        "nextReady": radio.next_track is not None,
        "historyCount": len(radio.history),
        "model": OLLAMA_MODEL,
        "listenerCount": len(radio._ws_connections),
    }


async def _require_member(request: Request) -> AuthUser:
    """Signed-in callers only, unless AUTH_ENFORCE=0 (the rollback switch).

    When the gate is off, an anonymous caller is given a placeholder identity so
    downstream code — logging, per-user rate limiting — has something to key on
    without every call site growing a None branch.
    """
    if not auth_module.auth_enforced():
        user = await auth_module.get_optional_user(request)
        return user or AuthUser(id="anonymous", email="", nickname="")
    return await get_current_user(request)


def _iter_audio(data: bytes, chunk_size: int = 65_536):
    """Yield audio bytes in chunks so the browser can start decoding immediately."""
    for i in range(0, len(data), chunk_size):
        yield data[i:i + chunk_size]


SAVED_TRACKS_DIR = Path(__file__).parent.parent / "saved_tracks"
REACTIONS_DIR = Path(__file__).parent.parent / "tracks_with_user_action"


@app.get("/api/audio/{track_id}")
async def get_audio(track_id: str):
    """Serve a cached audio file by track ID.

    Uses chunked transfer so the browser can start buffering and playing
    before the full file is received. Cache-Control allows the browser to
    serve the same file from its local cache when the pre-load element and
    the active player element both request the same URL.
    """
    logger.info(f"[main] GET /api/audio/{track_id} — cache has {len(radio.audio_cache)} entries")
    audio_bytes = radio.audio_cache.get(track_id)
    if not audio_bytes:
        # Tier 2 Fallback: Track was real but deeply evicted (client fell behind by > buffer window).
        # Serve live state instead of hard 404 so mobile app can snap back to reality.
        if track_id in radio.reaction_metadata_cache:
            best_live_track = radio.get_current_best_track()
            return {"status": "evicted", "syncNow": radio._make_track_dict(best_live_track) if best_live_track else None}

        logger.warning(
            f"[main] Audio 404 for track_id={track_id} | "
            f"current_track={radio.current_track.id if radio.current_track else 'none'} | "
            f"cache_keys={list(radio.audio_cache.keys())}"
        )
        raise HTTPException(status_code=404, detail="Track not found in cache")
    logger.info(f"[main] Serving {len(audio_bytes) / 1024:.1f} KB for track {track_id} (chunked)")
    return StreamingResponse(
        _iter_audio(audio_bytes),
        media_type="audio/mpeg",
        headers={
            "Content-Length": str(len(audio_bytes)),
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600",
        },
    )


@app.get("/api/library/index")
async def get_library_index(request: Request, user: AuthUser = Depends(_require_member)):
    """Full metadata for every track in the persistent library.

    Members only. This exposes the prompt, tags, seed, lyrics and DJ name of
    every track ever generated, and is the index a client walks to bulk-download
    the whole library — it was open to anyone who knew the public URL.

    ~1-2 MB for a full 500-track library. The payload is served from a cached
    encoding behind an ETag, so repeat opens of the offline panel cost a hash
    comparison rather than re-serializing 500 dicts on the event loop.
    """
    payload, etag = radio.library.index_payload()
    headers = {"ETag": etag, "Cache-Control": "private, max-age=60"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=payload, media_type="application/json", headers=headers)


@app.get("/api/library/audio/{track_id}")
async def get_library_audio(request: Request, track_id: str, user: AuthUser = Depends(_require_member)):
    """Serve a library mp3 from disk. track_id must be a known index key
    (this also makes path traversal impossible)."""
    # One offline download is up to 500 of these, so the ceiling is well above a
    # full run while still capping a scraper.
    ratelimit.check("library-audio", user.id, limit=700, window_s=600)
    path = radio.library.audio_path(track_id)
    if path is None:
        raise HTTPException(status_code=404, detail="Track not found in library")
    logger.debug(f"[main] Library audio {track_id} → user {user.id}")
    return FileResponse(
        path,
        media_type="audio/mpeg",
        filename=f"{track_id}.mp3",
        headers={"Cache-Control": "private, max-age=86400"},
    )


@app.post("/api/tracks/{track_id}/save")
async def save_track(track_id: str, request: Request):
    """Save the track's MP3 and a JSON metadata file to the saved_tracks/ directory.

    Restricted to local-network clients only — remote viewers cannot trigger disk writes.
    """
    client_ip = _resolve_request_ip(request)
    if not _is_local_ip(client_ip):
        logger.warning(f"[main] Save rejected — remote client {client_ip}")
        raise HTTPException(status_code=403, detail="Save is only available to local clients")
    logger.info(f"[main] POST /api/tracks/{track_id}/save")
    audio_bytes = radio.audio_cache.get(track_id)
    if not audio_bytes:
        raise HTTPException(status_code=404, detail="Track not found in cache")

    prompt = radio.prompt_cache.get(track_id)
    track_info = radio.track_info_cache.get(track_id)
    if not prompt or not track_info:
        raise HTTPException(status_code=404, detail="Track metadata not found")

    seed = radio.seed_cache.get(track_id, "")
    SAVED_TRACKS_DIR.mkdir(exist_ok=True)

    safe_title = re.sub(r'[^\w\s-]', '', track_info.song_title).strip()
    safe_title = re.sub(r'\s+', '_', safe_title)[:50]
    dt_str = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    base_name = f"{safe_title}.{dt_str}"

    mp3_path = SAVED_TRACKS_DIR / f"{base_name}.mp3"
    mp3_path.write_bytes(audio_bytes)

    metadata = {
        "trackId": track_id,
        "savedAt": datetime.now().isoformat(),
        "songTitle": track_info.song_title,
        "genre": track_info.genre,
        "isRandom": track_info.is_random,
        "bpm": track_info.bpm,
        "keyScale": track_info.key_scale,
        "duration": track_info.duration,
        "language": radio.language,
        "keywords": radio.keywords,
        "style": prompt.style,
        "instruments": prompt.instruments,
        "mood": prompt.mood,
        "vocalStyle": prompt.vocal_style,
        "production": prompt.production,
        "lyrics": prompt.lyrics,
        "tags": prompt.tags,
        "seed": seed,
        "advancedOptions": radio.advanced_options,
        "audioFile": f"{base_name}.mp3",
    }
    json_path = SAVED_TRACKS_DIR / f"{base_name}.json"
    json_path.write_text(json.dumps(metadata, indent=2, ensure_ascii=False))

    logger.info(f"[main] Track saved: {base_name}")
    return {"baseName": base_name}


@app.post("/api/tracks/{track_id}/react")
async def react_to_track(track_id: str, body: ReactRequest, request: Request):
    """Toggle a thumb_up or thumb_down reaction for the requesting client.

    Available to all clients (controller and viewers). Uses toggle semantics:
    pressing the same action again removes the vote; pressing the opposite side
    switches sides.
    """
    client_ip = _resolve_request_ip(request)
    logger.info(f"[main] POST /api/tracks/{track_id}/react — action={body.action.value}, ip={client_ip}")
    try:
        result = await radio.react(
            track_id=track_id,
            action=body.action.value,
            client_ip=client_ip,
            reactions_dir=REACTIONS_DIR,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return result


@app.post("/api/radio/track-ended")
async def http_track_ended(track_id: str | None = None):
    """HTTP fallback for mobile clients that cannot send WS track_ended after sleep.

    Accepts optional track_id query param so the server can ignore stale signals
    from clients that are behind the current pipeline position.

    Returns the best available track immediately:
      A) next_track ready → returns it (client plays the new track)
      B) next_track still generating → returns current_track (client re-plays briefly)
    """
    logger.info(f"[main] POST /api/radio/track-ended track_id={track_id}")
    await radio.on_track_ended(finished_track_id=track_id)
    track = radio.get_current_best_track()
    if track is None:
        return {"ok": True, "track": None}
    return {"ok": True, "track": track.model_dump()}


@app.get("/api/radio/next-track")
async def get_next_track():
    """Pull-based: returns the best available track to play next without side effects.

    A) next_track buffered and ready → returns it
    B) next_track still generating → returns current_track
    Returns 404 if no session is active.
    """
    track = radio.get_current_best_track()
    if track is None:
        raise HTTPException(status_code=404, detail="No active session")
    return {"track": track.model_dump()}


@app.get("/api/tracks/{track_id}/reactions")
async def get_track_reactions(track_id: str, request: Request):
    """Return current reaction counts and the caller's current vote for a track."""
    client_ip = _resolve_request_ip(request)
    logger.debug(f"[main] GET /api/tracks/{track_id}/reactions — ip={client_ip}")
    return await radio.get_reactions(
        track_id=track_id,
        client_ip=client_ip,
        reactions_dir=REACTIONS_DIR,
    )


# ------------------------------------------------------------------ #
# WebSocket
# ------------------------------------------------------------------ #

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    logger.info(f"[main] WebSocket accepted from {websocket.client}")

    # Browsers send the httpOnly cookie on a same-origin upgrade automatically;
    # React Native cannot, so mobile appends ?token=. An invalid or expired
    # token does NOT close the socket — the radio is public and only DJ mode is
    # gated, so a bad token simply degrades to an anonymous listener. The client
    # learns this from role_assigned.djAvailable rather than a dropped
    # connection mid-song.
    token = auth_module.extract_token_ws(websocket)
    user: AuthUser | None = None
    if token:
        try:
            user = auth_module.verify_token(token)
        except HTTPException:
            logger.info("[main] WS token rejected — connecting as anonymous listener")
            token = None
    radio.add_ws(websocket, user=user, token=token)
    try:
        while True:
            data = await websocket.receive_json()
            event = data.get("event")
            logger.debug(f"[main] WS message received: {event}")

            if event == "ping":
                pass  # keep-alive heartbeat from mobile clients, no action needed
            elif event == "track_ended":
                await radio.on_track_ended()
            elif event == "start":
                event_data = data.get("data", {})
                await radio.start_from_ws(
                    websocket,
                    genres=event_data.get("genres", []),
                    keywords=event_data.get("keywords", []),
                    language=event_data.get("language", "en"),
                    feeling=event_data.get("feeling", ""),
                    advanced_options=event_data.get("advancedOptions"),
                    dj_name=event_data.get("djName", ""),
                )
            elif event == "stop":
                await radio.stop_from_ws(websocket)
            elif event == "reschedule":
                event_data = data.get("data", {})
                await radio.reschedule_from_ws(
                    websocket,
                    genres=event_data.get("genres", []),
                    keywords=event_data.get("keywords", []),
                    language=event_data.get("language", "en"),
                    feeling=event_data.get("feeling", ""),
                    advanced_options=event_data.get("advancedOptions"),
                )
            elif event == "skip":
                await radio.skip_from_ws(websocket)
            elif event == "dj_claim":
                await radio.claim_dj_from_ws(websocket)
            elif event == "dj_cancel":
                await radio.cancel_dj_claim_from_ws(websocket)
            elif event == "dj_submit":
                event_data = data.get("data", {})
                # djName is deliberately NOT read: the DJ name comes from the
                # authenticated session. Older clients still send it; ignoring it
                # keeps them working and makes the field unspoofable.
                await radio.submit_dj_from_ws(
                    websocket,
                    genres=event_data.get("genres", []),
                    keywords=event_data.get("keywords", []),
                    language=event_data.get("language", "en"),
                    feeling=event_data.get("feeling", ""),
                )
            else:
                logger.warning(f"[main] Unknown WS event from client: {event}")

    except WebSocketDisconnect:
        logger.info(f"[main] WebSocket disconnected from {websocket.client}")
        radio.remove_ws(websocket)
    except Exception as e:
        logger.error(f"[main] WebSocket error: {e}", exc_info=True)
        radio.remove_ws(websocket)
