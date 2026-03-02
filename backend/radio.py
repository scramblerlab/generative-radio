import asyncio
import contextlib
import logging
import random
import time
import uuid
from typing import Any

from fastapi import WebSocket
from models import RadioState, TrackInfo, WSMessage, SongPrompt
from llm import OllamaClient
from acestep_client import ACEStepClient
from config import mem_snapshot, get_progressive_duration
from genres import GENRES, KEYWORDS

logger = logging.getLogger(__name__)


def _normalize_ip(raw: str) -> str:
    """Convert IPv6-mapped IPv4 addresses to plain IPv4 strings.

    FastAPI/uvicorn may report:
      ::1               → 127.0.0.1   (IPv6 loopback)
      ::ffff:192.168.x.y → 192.168.x.y (IPv6-mapped IPv4)
    All other values are returned unchanged.
    """
    if raw == "::1":
        return "127.0.0.1"
    if raw.startswith("::ffff:"):
        candidate = raw[7:]
        # Accept only if it looks like a dotted-quad IPv4
        parts = candidate.split(".")
        if len(parts) == 4 and all(p.isdigit() for p in parts):
            return candidate
    return raw


# Mapping from frontend merged category name → backend KEYWORDS category values
_RANDOM_KW_CAT_MAP: dict[str, set[str]] = {
    'emotion':    {'energy', 'emotion'},
    'atmosphere': {'atmosphere', 'texture'},
    'instrument': {'instrument'},
}


def _parse_keywords(keywords: list[str]) -> tuple[list[str], list[str]]:
    """Split a keywords list into (fixed_keywords, random_categories).

    Keywords matching the pattern ``__random_<cat>__`` are extracted as
    random-category markers; all others are treated as fixed selections.
    """
    fixed: list[str] = []
    random_cats: list[str] = []
    for kw in keywords:
        if kw.startswith('__random_') and kw.endswith('__'):
            cat = kw[len('__random_'):-len('__')]
            random_cats.append(cat)
        else:
            fixed.append(kw)
    return fixed, random_cats


class RadioOrchestrator:
    def __init__(self, llm: OllamaClient, acestep: ACEStepClient):
        self.llm = llm
        self.acestep = acestep

        # State
        self.state: RadioState = RadioState.IDLE
        self.genres: list[str] = []
        self.keywords: list[str] = []
        self.language: str = "en"             # ISO 639-1 code or "instrumental"
        self.feeling: str = ""                # Free-text mood from user
        self.advanced_options: dict = {}      # timeSignature, inferenceSteps, model, thinking, cot flags
        self._saved_advanced_options: dict = {}  # persists across sessions for cross-browser recall
        self._random_genre: bool = False          # True when controller selected "Random" genre mode
        self._random_keyword_categories: list[str] = []  # Categories with per-track random keyword picks
        self.history: list[str] = []          # Song titles played this session

        # Track management
        self.current_track: TrackInfo | None = None
        self.next_track: TrackInfo | None = None   # Pre-buffered; already sent to frontend as isNext=True
        self.audio_cache: dict[str, bytes] = {}       # track_id → raw MP3 bytes
        self.prompt_cache: dict[str, SongPrompt] = {}  # track_id → SongPrompt (for save)
        self.seed_cache: dict[str, str] = {}           # track_id → ACE-Step seed (for save)
        self.track_info_cache: dict[str, TrackInfo] = {}  # track_id → TrackInfo (for save)

        # Async primitives
        self._task: asyncio.Task | None = None
        self._prebuffer_task: asyncio.Task | None = None  # Background generation task
        self._stop_event = asyncio.Event()
        self._track_ended_event = asyncio.Event()
        self._next_track_ready_event = asyncio.Event()

        # Debounce: ignore duplicate track_ended signals within this window.
        # With N listeners each firing track_ended simultaneously, only the
        # first signal within _TRACK_ENDED_DEBOUNCE_S seconds is accepted.
        self._last_track_ended_at: float = 0.0

        # WebSocket connections
        self._ws_connections: list[WebSocket] = []
        self._ws_meta: dict[WebSocket, dict[str, Any]] = {}  # {ws: {ip, connected_at}}

        # Role management
        self._controller_ws: WebSocket | None = None
        self._pending_promotion: bool = False  # Promote next viewer once prebuffer finishes

    # ------------------------------------------------------------------ #
    # WebSocket connection management
    # ------------------------------------------------------------------ #

    def add_ws(self, ws: WebSocket) -> None:
        self._ws_connections.append(ws)
        ip = _normalize_ip(ws.client.host) if ws.client else "unknown"
        self._ws_meta[ws] = {"ip": ip, "connected_at": time.time()}
        if self._controller_ws is None:
            # First connection (or re-fill after controller left) → controller
            self._controller_ws = ws
            logger.info(f"[radio] WS connected as CONTROLLER ({ip}) — total: {len(self._ws_connections)}")
            asyncio.create_task(
                self._send_to(ws, WSMessage(event="role_assigned", data={"role": "controller"}))
            )
        else:
            # Subsequent connections → viewer; send role + late-join state snapshot
            logger.info(f"[radio] WS connected as VIEWER ({ip}) — total: {len(self._ws_connections)}")
            asyncio.create_task(self._send_viewer_snapshot(ws))
        asyncio.create_task(self._broadcast_listener_count())
        asyncio.create_task(self._broadcast_viewer_list_to_controller())

    def remove_ws(self, ws: WebSocket) -> None:
        if ws in self._ws_connections:
            self._ws_connections.remove(ws)
        self._ws_meta.pop(ws, None)
        logger.info(f"[radio] WS disconnected — total connections: {len(self._ws_connections)}")

        if ws == self._controller_ws:
            self._controller_ws = None
            logger.info("[radio] Controller disconnected")
            prebuffer_active = (
                self._prebuffer_task is not None and not self._prebuffer_task.done()
            )
            if prebuffer_active:
                logger.info("[radio] Background generation in progress — deferring viewer promotion")
                self._pending_promotion = True
            else:
                asyncio.create_task(self._promote_next_controller())

        asyncio.create_task(self._broadcast_listener_count())
        asyncio.create_task(self._broadcast_viewer_list_to_controller())

    # ------------------------------------------------------------------ #
    # Public control methods
    # ------------------------------------------------------------------ #

    async def start(
        self, genres: list[str], keywords: list[str],
        language: str = "en", feeling: str = "",
        advanced_options: dict | None = None,
    ) -> None:
        """Start a new radio session, stopping any existing one first."""
        if self._task and not self._task.done():
            logger.info("[radio] Stopping existing session before starting new one")
            await self.stop()

        if genres == ['__random__']:
            self._random_genre = True
            self.genres = []
        else:
            self._random_genre = False
            self.genres = genres
        self.keywords, self._random_keyword_categories = _parse_keywords(keywords)
        self.language = language
        self.feeling = feeling
        self.advanced_options = advanced_options or {}
        if self.advanced_options:
            self._saved_advanced_options = dict(self.advanced_options)
        self.history = []
        self.next_track = None
        self._stop_event.clear()
        self._track_ended_event.clear()
        self._next_track_ready_event.clear()
        self.audio_cache.clear()
        self.prompt_cache.clear()
        self.seed_cache.clear()
        self.track_info_cache.clear()
        self._last_track_ended_at = 0.0
        self._pending_promotion = False

        logger.info(f"[radio] Starting session — genres: {genres}, keywords: {keywords}, language: {language}, feeling: {feeling[:50]!r}, advanced: {self.advanced_options}")
        self._task = asyncio.create_task(self._radio_loop(), name="radio-loop")

    async def stop(self) -> None:
        """Stop the radio session and clean up resources."""
        logger.info("[radio] Stop requested")
        self._stop_event.set()
        self._track_ended_event.set()      # Unblock waiting loop
        self._next_track_ready_event.set() # Unblock buffering wait

        self._cancel_prebuffer()

        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass

        self.state = RadioState.STOPPED
        self.current_track = None
        self.next_track = None
        self.audio_cache.clear()
        self.prompt_cache.clear()
        self.seed_cache.clear()
        self.track_info_cache.clear()
        logger.info("[radio] Session stopped and cleaned up")

    async def skip(self) -> None:
        """Skip the current track — signal the radio loop to advance."""
        logger.info("[radio] Skip requested — signalling track_ended")
        self._track_ended_event.set()

    async def on_track_ended(self) -> None:
        """Called when the frontend reports the current track has finished playing.

        With N simultaneous listeners each sending track_ended, only the first
        signal within _TRACK_ENDED_DEBOUNCE_S seconds is honoured; the rest are
        silently dropped to prevent N-1 spurious track advances.
        """
        _DEBOUNCE_S = 5.0
        now = asyncio.get_event_loop().time()
        if now - self._last_track_ended_at < _DEBOUNCE_S:
            logger.info(
                "[radio] track_ended debounced "
                f"({now - self._last_track_ended_at:.2f}s since last) — ignoring duplicate"
            )
            return
        self._last_track_ended_at = now
        logger.info("[radio] Track-ended signal accepted — advancing to next track")
        self._track_ended_event.set()

    # ------------------------------------------------------------------ #
    # WebSocket-gated control (called from WS handler in main.py)
    # ------------------------------------------------------------------ #

    async def start_from_ws(
        self, ws: WebSocket, genres: list[str], keywords: list[str],
        language: str = "en", feeling: str = "",
        advanced_options: dict | None = None,
    ) -> None:
        """Start the radio session — authorised only for the current controller."""
        if ws != self._controller_ws:
            logger.warning("[radio] start_from_ws rejected — sender is not the controller")
            await self._send_to(
                ws, WSMessage(event="error", data={"message": "Only the host can start the radio"})
            )
            return
        if not genres:
            await self._send_to(
                ws, WSMessage(event="error", data={"message": "At least one genre is required"})
            )
            return
        await self.start(genres, keywords, language, feeling, advanced_options)

    async def stop_from_ws(self, ws: WebSocket) -> None:
        """Stop the radio session — authorised only for the current controller."""
        if ws != self._controller_ws:
            logger.warning("[radio] stop_from_ws rejected — sender is not the controller")
            await self._send_to(
                ws, WSMessage(event="error", data={"message": "Only the host can stop the radio"})
            )
            return
        await self.stop()

    async def reschedule(
        self,
        genres: list[str],
        keywords: list[str],
        language: str = "en",
        feeling: str = "",
        advanced_options: dict | None = None,
    ) -> None:
        """Update settings mid-session: keep current track playing, restart pre-buffer with new settings.
        Falls back to a full start() if not currently in a playing/buffering state."""
        if self.state not in (RadioState.PLAYING, RadioState.BUFFERING):
            logger.info("[radio] reschedule called but not playing — doing full start()")
            await self.start(genres, keywords, language, feeling, advanced_options)
            return

        logger.info(
            f"[radio] Rescheduling — new genres: {genres}, keywords: {keywords}, language: {language}"
        )

        # Update settings (take effect for the next generated track onwards)
        if genres == ['__random__']:
            self._random_genre = True
            self.genres = []
        else:
            self._random_genre = False
            self.genres = genres
        self.keywords, self._random_keyword_categories = _parse_keywords(keywords)
        self.language = language
        self.feeling = feeling
        self.advanced_options = advanced_options or {}
        if self.advanced_options:
            self._saved_advanced_options = dict(self.advanced_options)
        self.history = []        # Reset so new genre isn't biased by old session history

        # Discard any pre-buffered next track — it was generated with old settings
        self._cancel_prebuffer()
        if self.next_track:
            _discard_id = self.next_track.id
            self.audio_cache.pop(_discard_id, None)
            self.prompt_cache.pop(_discard_id, None)
            self.seed_cache.pop(_discard_id, None)
            self.track_info_cache.pop(_discard_id, None)
            logger.info(
                f"[radio] Discarded pre-buffered track '{self.next_track.song_title}' (old settings)"
            )
        self.next_track = None
        self._next_track_ready_event.clear()

        # Kick off a fresh pre-buffer with the new settings; current track keeps playing
        self._start_prebuffer()

        await self._broadcast_status("playing", "Settings updated — generating next track...")

    async def reschedule_from_ws(
        self,
        ws: WebSocket,
        genres: list[str],
        keywords: list[str],
        language: str = "en",
        feeling: str = "",
        advanced_options: dict | None = None,
    ) -> None:
        """reschedule() gated to the current controller."""
        if ws != self._controller_ws:
            logger.warning("[radio] reschedule_from_ws rejected — sender is not the controller")
            await self._send_to(
                ws, WSMessage(event="error", data={"message": "Only the host can change settings"})
            )
            return
        if not genres:
            await self._send_to(
                ws, WSMessage(event="error", data={"message": "At least one genre is required"})
            )
            return
        await self.reschedule(genres, keywords, language, feeling, advanced_options)

    async def skip_from_ws(self, ws: WebSocket) -> None:
        """Skip the current track — authorised only for the current controller."""
        if ws != self._controller_ws:
            logger.warning("[radio] skip_from_ws rejected — sender is not the controller")
            await self._send_to(
                ws, WSMessage(event="error", data={"message": "Only the host can skip tracks"})
            )
            return
        await self.skip()

    @property
    def saved_advanced_options(self) -> dict:
        """Last-used advanced options, persisted across sessions for cross-browser recall."""
        return self._saved_advanced_options

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #

    def _cancel_prebuffer(self) -> None:
        """Cancel any in-flight background track generation task."""
        if self._prebuffer_task and not self._prebuffer_task.done():
            self._prebuffer_task.cancel()
            logger.debug("[radio] Cancelled in-flight prebuffer task")
        self._prebuffer_task = None

    def _start_prebuffer(self) -> None:
        """Cancel any existing prebuffer task and start a fresh one."""
        self._cancel_prebuffer()
        self._prebuffer_task = asyncio.create_task(
            self._generate_and_buffer_next(), name="radio-prebuffer"
        )

    async def _send_to(self, ws: WebSocket, message: WSMessage) -> None:
        """Unicast a message to a single WebSocket client."""
        try:
            await ws.send_text(message.model_dump_json())
        except Exception as e:
            logger.warning(f"[radio] Failed to unicast to WS: {e}")
            self.remove_ws(ws)

    async def _send_viewer_snapshot(self, ws: WebSocket) -> None:
        """Unicast role_assigned:viewer + current session state to a newly connected viewer.

        This ensures late-joining clients see the current track immediately without
        waiting for the next broadcast cycle.
        """
        await self._send_to(ws, WSMessage(event="role_assigned", data={"role": "viewer"}))

        # Only send state if a session is actually running
        if self.state in (RadioState.IDLE, RadioState.STOPPED):
            return

        if self.current_track:
            ct = self.current_track
            await self._send_to(
                ws,
                WSMessage(
                    event="track_ready",
                    data={
                        "track": {
                            "id": ct.id,
                            "songTitle": ct.song_title,
                            "tags": ct.tags,
                            "lyrics": ct.lyrics,
                            "bpm": ct.bpm,
                            "keyScale": ct.key_scale,
                            "duration": ct.duration,
                            "audioUrl": ct.audio_url,
                        },
                        "isNext": False,
                    },
                ),
            )

        if self.state == RadioState.PLAYING:
            msg = (
                "Playing — next track ready"
                if self.next_track
                else "Playing — generating next track..."
            )
        elif self.state == RadioState.GENERATING:
            msg = "Generating your first track..."
        elif self.state == RadioState.BUFFERING:
            msg = "Buffering next track..."
        else:
            msg = ""

        await self._send_to(
            ws,
            WSMessage(
                event="status",
                data={
                    "state": self.state.value,
                    "message": msg,
                    "nextReady": self.next_track is not None,
                },
            ),
        )

    async def _promote_next_controller(self) -> None:
        """Promote the first waiting viewer to the controller role."""
        self._pending_promotion = False
        if not self._ws_connections:
            logger.info("[radio] No viewers to promote — controller slot is vacant")
            return
        new_controller = self._ws_connections[0]
        self._controller_ws = new_controller
        logger.info("[radio] Viewer promoted to controller")
        await self._send_to(
            new_controller,
            WSMessage(event="role_assigned", data={"role": "controller"}),
        )
        # Send fresh viewer list to the newly promoted controller
        await self._broadcast_viewer_list_to_controller()

    def _viewer_list_data(self) -> list[dict[str, Any]]:
        """Return metadata for all viewers (excluding the controller)."""
        result = []
        for ws in self._ws_connections:
            if ws == self._controller_ws:
                continue
            meta = self._ws_meta.get(ws, {})
            result.append({
                "ip": meta.get("ip", "unknown"),
                "connectedAt": meta.get("connected_at", 0),
            })
        return result

    async def _broadcast_viewer_list_to_controller(self) -> None:
        """Unicast the current viewer list to the controller only."""
        if not self._controller_ws:
            return
        viewers = self._viewer_list_data()
        logger.debug(f"[radio] Sending viewer_list to controller: {len(viewers)} viewer(s)")
        await self._send_to(
            self._controller_ws,
            WSMessage(event="viewer_list", data={"viewers": viewers}),
        )

    # ------------------------------------------------------------------ #
    # Main radio loop
    # ------------------------------------------------------------------ #

    async def _radio_loop(self) -> None:
        try:
            logger.info("[radio] Radio loop starting")

            # Verify ACE-Step is reachable before doing anything
            if not await self.acestep.health_check():
                await self._broadcast_error(
                    "ACE-Step server is not responding. "
                    "Please ensure it is running on port 8001."
                )
                self.state = RadioState.STOPPED
                return

            # --- Generate the first track ---
            self.state = RadioState.GENERATING
            await self._broadcast_status("generating", "Generating your first track...")
            logger.info("[radio] Generating first track...")

            t0 = time.monotonic()
            current = await self._generate_track()
            logger.info(
                f"[radio] First track ready: '{current.song_title}' "
                f"(took {time.monotonic() - t0:.1f}s)"
            )

            self.current_track = current
            self.state = RadioState.PLAYING
            await self._broadcast_track_ready(current, is_next=False)
            await self._broadcast_status("playing", "Playing — generating next track...")

            # Start pre-generating the second track in the background
            self._start_prebuffer()

            # --- Main loop ---
            while not self._stop_event.is_set():
                self._track_ended_event.clear()
                logger.info(f"[radio] Waiting for track to end: '{self.current_track.song_title}'")

                await self._track_ended_event.wait()

                if self._stop_event.is_set():
                    logger.info("[radio] Stop event received — exiting loop")
                    break

                logger.info("[radio] Track ended — transitioning to next track")

                if self.next_track is not None:
                    # Happy path: next track was already pre-buffered and sent
                    # to the frontend as isNext=True. The frontend is already
                    # playing it — just update server state and keep going.
                    logger.info(
                        f"[radio] Next track was pre-buffered: '{self.next_track.song_title}' "
                        f"— frontend already playing it"
                    )
                    old_id = self.current_track.id if self.current_track else None
                    self.current_track = self.next_track
                    self.next_track = None
                    self._next_track_ready_event.clear()
                    if old_id:
                        self.audio_cache.pop(old_id, None)
                        self.prompt_cache.pop(old_id, None)
                        self.seed_cache.pop(old_id, None)
                        self.track_info_cache.pop(old_id, None)
                        logger.debug(f"[radio] Evicted caches for finished track: {old_id}")
                    self.state = RadioState.PLAYING
                    await self._broadcast_status("playing", "Playing — generating next track...")
                else:
                    # Buffering path: next track still generating — wait for it.
                    logger.info("[radio] Next track not ready — entering buffering state")
                    self.state = RadioState.BUFFERING
                    await self._broadcast_status("buffering", "Buffering next track...")

                    await self._next_track_ready_event.wait()

                    if self._stop_event.is_set():
                        break

                    track = self.next_track
                    self.next_track = None
                    self._next_track_ready_event.clear()
                    old_id = self.current_track.id if self.current_track else None
                    self.current_track = track
                    if old_id:
                        self.audio_cache.pop(old_id, None)
                        self.prompt_cache.pop(old_id, None)
                        self.seed_cache.pop(old_id, None)
                        self.track_info_cache.pop(old_id, None)
                        logger.debug(f"[radio] Evicted caches for finished track: {old_id}")
                    self.state = RadioState.PLAYING

                    logger.info(f"[radio] Buffering done — now playing: '{track.song_title}'")
                    await self._broadcast_track_ready(track, is_next=False)
                    await self._broadcast_status("playing", "Playing — generating next track...")

                # Kick off next-next track generation, cancelling any stale task first
                self._start_prebuffer()

        except asyncio.CancelledError:
            logger.info("[radio] Radio loop task cancelled")
        except Exception as e:
            logger.error(f"[radio] Unhandled error in radio loop: {e}", exc_info=True)
            await self._broadcast_error(f"Radio error: {e}")
            self.state = RadioState.STOPPED
        finally:
            logger.info("[radio] Radio loop exited")

    async def _generate_and_buffer_next(self) -> None:
        """Generate the next track in the background and notify the frontend.

        Checks _stop_event after generation to avoid broadcasting into a
        stopped session (e.g. if stop() was called while generating).
        """
        try:
            logger.info("[radio] Background: starting next track generation...")
            t0 = time.monotonic()
            track = await self._generate_track()
            elapsed = time.monotonic() - t0

            # Guard: the session may have been stopped while we were generating
            if self._stop_event.is_set():
                logger.info(
                    f"[radio] Background generation done but session stopped "
                    f"— discarding '{track.song_title}'"
                )
                return

            logger.info(
                f"[radio] Background: next track ready: '{track.song_title}' "
                f"(took {elapsed:.1f}s)"
            )

            self.next_track = track
            self._next_track_ready_event.set()

            # Notify frontend — it caches this and plays immediately on track_ended
            await self._broadcast_track_ready(track, is_next=True)
            await self._broadcast_status("playing", "Playing — next track ready")

            # Promote any deferred controller now that generation is complete
            if self._pending_promotion:
                logger.info("[radio] Promoting deferred viewer to controller (generation complete)")
                await self._promote_next_controller()

        except asyncio.CancelledError:
            logger.info("[radio] Background generation cancelled")
        except Exception as e:
            logger.error(f"[radio] Background generation error: {e}", exc_info=True)
            await self._broadcast_error(f"Failed to generate next track: {e}")

    # ------------------------------------------------------------------ #
    # Track generation pipeline
    # ------------------------------------------------------------------ #

    async def _generate_track(self) -> TrackInfo:
        """LLM → ACE-Step → audio cache. Returns a fully ready TrackInfo."""
        short_id = str(uuid.uuid4())[:8]
        track_index = len(self.history)  # 0-based; history grows after each completed track
        target_duration = get_progressive_duration(track_index)
        logger.info(
            f"[radio] [{short_id}] Starting track generation "
            f"(session history: {track_index} songs, target duration: {target_duration}s)"
        )

        # Step 1: LLM generates a structured song prompt
        # Determine the genre(s) to use for this track
        if self._random_genre:
            _picked = random.choice(GENRES)
            genres_for_llm = [_picked['id']]
            genre_label = _picked['label']
            logger.info(f"[radio] [{short_id}] Random genre picked: {genre_label}")
        else:
            genres_for_llm = self.genres
            genre_label = next(
                (g['label'] for g in GENRES if g['id'] == genres_for_llm[0]),
                genres_for_llm[0] if genres_for_llm else "",
            )

        # Resolve random keyword categories: pick one keyword per category each track
        keywords_for_llm = list(self.keywords)
        for cat in self._random_keyword_categories:
            backend_cats = _RANDOM_KW_CAT_MAP.get(cat, {cat})
            pool = [k['id'] for k in KEYWORDS if k['category'] in backend_cats]
            if pool:
                pick = random.choice(pool)
                keywords_for_llm.append(pick)
                logger.info(f"[radio] [{short_id}] Random keyword picked for '{cat}': {pick}")

        await self._broadcast_progress("llm_thinking", "DJ is writing the next song prompt…")
        logger.info(f"[radio] [{short_id}] Before LLM    — {mem_snapshot()}")
        logger.info(f"[radio] [{short_id}] Calling LLM for song prompt...")
        t_llm = time.monotonic()
        song_prompt: SongPrompt = await self.llm.generate_prompt(
            genres_for_llm, keywords_for_llm, self.history,
            duration=target_duration, language=self.language,
            feeling=self.feeling,
        )
        logger.info(
            f"[radio] [{short_id}] LLM done in {time.monotonic() - t_llm:.1f}s — "
            f"'{song_prompt.song_title}' | {song_prompt.bpm} BPM | {song_prompt.key_scale}"
        )
        await self._broadcast_progress(
            "llm_done",
            f'"{song_prompt.song_title}" · {song_prompt.bpm} BPM · {song_prompt.key_scale}',
            {
                "title": song_prompt.song_title,
                "tags": song_prompt.tags,
                "bpm": song_prompt.bpm,
                "key": song_prompt.key_scale,
                "llmSeconds": round(time.monotonic() - t_llm, 1),
            },
        )

        # Step 2: ACE-Step generates the audio
        logger.info(f"[radio] [{short_id}] Before ACE-Step — {mem_snapshot()}")
        await self._broadcast_progress(
            "acestep_start",
            f'Composing "{song_prompt.song_title}"…',
            {"title": song_prompt.song_title},
        )
        opts = self.advanced_options
        logger.info(
            f"[radio] [{short_id}] Sending to ACE-Step — advanced_options: {opts}"
        )
        t_ace = time.monotonic()

        async def _emit_acestep_progress() -> None:
            """Broadcast a heartbeat every 15 s while ACE-Step works."""
            while True:
                await asyncio.sleep(15)
                elapsed = int(time.monotonic() - t_ace)
                await self._broadcast_progress(
                    "acestep_progress",
                    f'Still composing "{song_prompt.song_title}"… ({elapsed}s)',
                    {"elapsed": elapsed},
                )

        _progress_task = asyncio.create_task(_emit_acestep_progress())
        try:
            audio_bytes, result_meta = await self.acestep.generate_song(
                song_prompt, vocal_language=self.language,
                time_signature=opts.get("timeSignature"),
                inference_steps=opts.get("inferenceSteps", 8),
                model=opts.get("model"),
                seed=None,
                thinking=opts.get("thinking", True),
                use_cot_caption=opts.get("useCotCaption", False),
                use_cot_metas=opts.get("useCotMetas", False),
                use_cot_language=opts.get("useCotLanguage", False),
            )
        finally:
            _progress_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await _progress_task

        # Capture seed from ACE-Step result (stored per track for Save Track)
        result_seed = str(result_meta.get("seed_value", ""))
        if result_seed:
            logger.info(f"[radio] [{short_id}] Captured seed from result: {result_seed}")
        else:
            logger.warning(f"[radio] [{short_id}] No seed_value in ACE-Step result metadata")

        elapsed_ace = time.monotonic() - t_ace
        logger.info(
            f"[radio] [{short_id}] ACE-Step done in {elapsed_ace:.1f}s — "
            f"{len(audio_bytes) / 1024:.1f} KB"
        )
        logger.info(f"[radio] [{short_id}] After ACE-Step  — {mem_snapshot()}")
        await self._broadcast_progress(
            "acestep_done",
            f'"{song_prompt.song_title}" ready in {elapsed_ace:.0f}s — loading…',
            {"title": song_prompt.song_title, "aceSeconds": round(elapsed_ace, 1)},
        )

        # Step 3: Cache audio bytes and build TrackInfo
        track_id = str(uuid.uuid4())
        self.audio_cache[track_id] = audio_bytes
        self.prompt_cache[track_id] = song_prompt
        self.seed_cache[track_id] = result_seed
        logger.info(f"[radio] [{short_id}] Cached as track_id: {track_id}")

        # Keep session history bounded (last 20 titles)
        self.history.append(song_prompt.song_title)
        if len(self.history) > 20:
            self.history = self.history[-20:]

        track_info = TrackInfo(
            id=track_id,
            song_title=song_prompt.song_title,
            genre=genre_label,
            is_random=self._random_genre,
            tags=song_prompt.tags,
            lyrics=song_prompt.lyrics,
            bpm=song_prompt.bpm,
            key_scale=song_prompt.key_scale,
            duration=song_prompt.duration,
            audio_url=f"/api/audio/{track_id}",
        )
        self.track_info_cache[track_id] = track_info
        return track_info

    # ------------------------------------------------------------------ #
    # WebSocket broadcast helpers
    # ------------------------------------------------------------------ #

    async def _broadcast_track_ready(self, track: TrackInfo, is_next: bool) -> None:
        track_dict = {
            "id": track.id,
            "songTitle": track.song_title,
            "genre": track.genre,
            "isRandom": track.is_random,
            "tags": track.tags,
            "lyrics": track.lyrics,
            "bpm": track.bpm,
            "keyScale": track.key_scale,
            "duration": track.duration,
            "audioUrl": track.audio_url,
        }
        label = "next (pre-buffered)" if is_next else "current (play now)"
        logger.info(f"[radio] Broadcasting track_ready — '{track.song_title}' [{label}]")
        await self.broadcast(WSMessage(event="track_ready", data={"track": track_dict, "isNext": is_next}))

    async def _broadcast_status(self, state: str, message: str) -> None:
        logger.debug(f"[radio] Status broadcast: [{state}] {message}")
        await self.broadcast(
            WSMessage(
                event="status",
                data={
                    "state": state,
                    "message": message,
                    "nextReady": self.next_track is not None,
                },
            )
        )

    async def _broadcast_progress(
        self, stage: str, message: str, data: dict | None = None
    ) -> None:
        logger.info(f"[radio] Progress [{stage}] {message}")
        await self.broadcast(
            WSMessage(event="progress", data={"stage": stage, "message": message, **(data or {})})
        )

    async def _broadcast_listener_count(self) -> None:
        count = len(self._ws_connections)
        logger.debug(f"[radio] Listener count: {count}")
        await self.broadcast(WSMessage(event="listener_count", data={"count": count}))

    async def _broadcast_error(self, message: str) -> None:
        logger.error(f"[radio] Error broadcast: {message}")
        await self.broadcast(WSMessage(event="error", data={"message": message}))

    async def broadcast(self, message: WSMessage) -> None:
        """Send a message to all connected WebSocket clients; prune dead connections."""
        if not self._ws_connections:
            return

        payload = message.model_dump_json()
        dead: list[WebSocket] = []

        for ws in self._ws_connections:
            try:
                await ws.send_text(payload)
            except Exception as e:
                logger.warning(f"[radio] Failed to send to WS client: {e}")
                dead.append(ws)

        for ws in dead:
            self.remove_ws(ws)
