import json
import logging
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

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
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


SAVED_TRACKS_DIR = Path(__file__).parent.parent / "saved_tracks"


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


@app.post("/api/tracks/{track_id}/save")
async def save_track(track_id: str):
    """Save the track's MP3 and a JSON metadata file to the saved_tracks/ directory."""
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
    return {"mp3": str(mp3_path), "json": str(json_path), "baseName": base_name}


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
            elif event == "dj_claim":
                await radio.claim_dj_from_ws(websocket)
            elif event == "dj_submit":
                event_data = data.get("data", {})
                await radio.submit_dj_from_ws(
                    websocket,
                    genres=event_data.get("genres", []),
                    keywords=event_data.get("keywords", []),
                    language=event_data.get("language", "en"),
                    feeling=event_data.get("feeling", ""),
                    dj_name=event_data.get("djName", ""),
                )
            else:
                logger.warning(f"[main] Unknown WS event from client: {event}")

    except WebSocketDisconnect:
        logger.info(f"[main] WebSocket disconnected from {websocket.client}")
        radio.remove_ws(websocket)
    except Exception as e:
        logger.error(f"[main] WebSocket error: {e}", exc_info=True)
        radio.remove_ws(websocket)
