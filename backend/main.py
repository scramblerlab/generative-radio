import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

# Configure logging before any other imports so all modules inherit this format.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from config import OLLAMA_MODEL
from genres import GENRES, KEYWORDS, LANGUAGES
from llm import OllamaClient
from acestep_client import ACEStepClient
from radio import RadioOrchestrator

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
    logger.info("=" * 60)

    yield  # application runs here

    logger.info("[main] Shutting down — stopping radio and closing clients")
    await radio.stop()
    await acestep.close()
    logger.info("[main] Shutdown complete")


# ------------------------------------------------------------------ #
# App setup
# ------------------------------------------------------------------ #

app = FastAPI(title="Generative Radio", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
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


@app.get("/api/radio/status")
async def get_status():
    """Return current radio state and track info."""
    logger.debug("[main] GET /api/radio/status")
    track = None
    if radio.current_track:
        ct = radio.current_track
        track = {
            "id": ct.id,
            "songTitle": ct.song_title,
            "tags": ct.tags,
            "lyrics": ct.lyrics,
            "bpm": ct.bpm,
            "keyScale": ct.key_scale,
            "duration": ct.duration,
            "audioUrl": ct.audio_url,
        }
    return {
        "state": radio.state.value,
        "currentTrack": track,
        "nextReady": radio.next_track is not None,
        "historyCount": len(radio.history),
        "model": OLLAMA_MODEL,
        "listenerCount": len(radio._ws_connections),
    }


def _iter_audio(data: bytes, chunk_size: int = 65_536):
    """Yield audio bytes in chunks so the browser can start decoding immediately."""
    for i in range(0, len(data), chunk_size):
        yield data[i:i + chunk_size]


@app.get("/api/audio/{track_id}")
async def get_audio(track_id: str):
    """Serve a cached audio file by track ID.

    Uses chunked transfer so the browser can start buffering and playing
    before the full file is received. Cache-Control allows the browser to
    serve the same file from its local cache when the pre-load element and
    the active player element both request the same URL.
    """
    logger.debug(f"[main] GET /api/audio/{track_id}")
    audio_bytes = radio.audio_cache.get(track_id)
    if not audio_bytes:
        logger.warning(f"[main] Audio not found for track_id: {track_id}")
        raise HTTPException(status_code=404, detail="Track not found in cache")
    logger.debug(f"[main] Serving {len(audio_bytes) / 1024:.1f} KB for track {track_id} (chunked)")
    return StreamingResponse(
        _iter_audio(audio_bytes),
        media_type="audio/mpeg",
        headers={
            "Content-Length": str(len(audio_bytes)),
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600",
        },
    )


# ------------------------------------------------------------------ #
# WebSocket
# ------------------------------------------------------------------ #

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    logger.info(f"[main] WebSocket accepted from {websocket.client}")
    radio.add_ws(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            event = data.get("event")
            logger.debug(f"[main] WS message received: {event}")

            if event == "track_ended":
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
            elif event == "pin_seed":
                seed = data.get("data", {}).get("seed", "")
                if seed:
                    await radio.pin_seed_from_ws(websocket, seed)
            elif event == "unpin_seed":
                await radio.unpin_seed_from_ws(websocket)
            else:
                logger.warning(f"[main] Unknown WS event from client: {event}")

    except WebSocketDisconnect:
        logger.info(f"[main] WebSocket disconnected from {websocket.client}")
        radio.remove_ws(websocket)
    except Exception as e:
        logger.error(f"[main] WebSocket error: {e}", exc_info=True)
        radio.remove_ws(websocket)
