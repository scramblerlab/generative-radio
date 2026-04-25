import asyncio
import collections
import contextlib
import ipaddress
import json
import logging
import random
import time
import uuid
from datetime import datetime
from pathlib import Path
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


def _is_local_ip(ip: str) -> bool:
    """Return True if the IP is a loopback or private (RFC 1918 / ULA) address."""
    try:
        addr = ipaddress.ip_address(ip)
        return addr.is_loopback or addr.is_private
    except ValueError:
        return False


def _resolve_client_ip(ws: WebSocket) -> str:
    """Determine the real client IP, checking proxy/CDN headers first.

    When served behind Cloudflare Tunnel, ws.client.host is always 127.0.0.1
    (the local cloudflared process).  Cloudflare injects CF-Connecting-IP with
    the actual visitor's IP, allowing us to distinguish local vs remote clients.
    """
    # Cloudflare: real visitor IP
    cf_ip = ws.headers.get("cf-connecting-ip", "").strip()
    if cf_ip:
        return _normalize_ip(cf_ip)
    # Standard reverse-proxy header: first entry is the originating client
    forwarded = ws.headers.get("x-forwarded-for", "").strip()
    if forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return _normalize_ip(first)
    # Direct connection
    return _normalize_ip(ws.client.host) if ws.client else "unknown"


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

        # Reaction tracking (in-memory; never written to disk directly)
        self.thumb_up_voters: dict[str, set[str]] = {}    # track_id → set of voter IPs
        self.thumb_down_voters: dict[str, set[str]] = {}  # track_id → set of voter IPs
        self.reaction_locks: dict[str, asyncio.Lock] = {} # track_id → asyncio.Lock
        # Snapshot of track metadata + audio bytes captured at generation time.
        # Unlike track_info_cache/audio_cache (evicted on track transition), this
        # persists for the whole session so users can still react after a track ends.
        self.reaction_metadata_cache: dict[str, dict] = {}  # track_id → metadata blob

        # Async primitives
        self._task: asyncio.Task | None = None
        self._prebuffer_task: asyncio.Task | None = None  # Background generation task
        self._play_now_task: asyncio.Task | None = None   # Watchdog: fire play_now if ended never arrives
        
        # Adaptive eviction / retention buffer properties
        self._retention_buffer_size = int(os.getenv("TRACK_RETENTION_N", "2"))
        self._eviction_queue: collections.deque = collections.deque(maxlen=self._retention_buffer_size)
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

        # DJ mode
        self._DJ_LOCK_S: float = 180.0  # default 3 min; overridden by advanced_options.djLockSeconds
        self._dj_lock_until: float = time.time() + self._DJ_LOCK_S  # locked on server start
        self._dj_claimant_ws: WebSocket | None = None  # WS that won claim but hasn't submitted yet
        self._dj_name: str = ""  # Current DJ name; drives title suffix for all subsequent tracks
        self._pending_settings: dict | None = None  # Queued genre/keyword change, applied on next _start_prebuffer()

    # ------------------------------------------------------------------ #
    # WebSocket connection management
    # ------------------------------------------------------------------ #

    def add_ws(self, ws: WebSocket) -> None:
        self._ws_connections.append(ws)
        ip = _resolve_client_ip(ws)
        is_local = _is_local_ip(ip)
        self._ws_meta[ws] = {"ip": ip, "connected_at": time.time(), "is_local": is_local}
        if self._controller_ws is None and is_local:
            # First local connection (or re-fill after controller left) → controller
            self._controller_ws = ws
            logger.info(f"[radio] WS connected as CONTROLLER ({ip}) — total: {len(self._ws_connections)}")
            asyncio.create_task(self._send_controller_snapshot(ws))
        else:
            # Remote clients, or when a local controller already exists → viewer
            reason = "remote client" if not is_local else "controller already active"
            logger.info(f"[radio] WS connected as VIEWER ({ip}, {reason}) — total: {len(self._ws_connections)}")
            asyncio.create_task(self._send_viewer_snapshot(ws))
        asyncio.create_task(self._broadcast_listener_count())
        asyncio.create_task(self._broadcast_viewer_list_to_controller())
        asyncio.create_task(self._broadcast_dj_state())

        # Auto-start with RANDOM genre when the first client connects to an idle radio.
        # This covers both controller and remote-only (viewer) connections.
        if self.state == RadioState.IDLE and len(self._ws_connections) == 1:
            logger.info("[radio] First client connected to idle radio — auto-starting RANDOM session")
            self._dj_name = "Auto"
            asyncio.create_task(self.start(["__random__"], ["__random_emotion__", "__random_instrument__"], "en", ""))

    def remove_ws(self, ws: WebSocket) -> None:
        if ws in self._ws_connections:
            self._ws_connections.remove(ws)
        self._ws_meta.pop(ws, None)
        logger.info(f"[radio] WS disconnected — total connections: {len(self._ws_connections)}")

        if ws == self._dj_claimant_ws:
            self._dj_claimant_ws = None
            asyncio.create_task(self._broadcast_dj_state())

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
        logger.info(
            f"[radio] Keywords parsed — fixed: {self.keywords or 'none'}, "
            f"random categories: {self._random_keyword_categories or 'none'}"
        )
        self.language = language
        self.feeling = feeling
        self.advanced_options = advanced_options or {}
        if self.advanced_options:
            self._saved_advanced_options = dict(self.advanced_options)
            self._DJ_LOCK_S = float(self.advanced_options.get("djLockSeconds", self._DJ_LOCK_S))
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

    # ------------------------------------------------------------------ #
    # Play-now watchdog (server-side safety net for unreliable `ended`)
    # ------------------------------------------------------------------ #

    async def _play_now_watchdog(self, track_id: str, delay: float) -> None:
        """Sleep delay seconds, then push play_now if still on the same track."""
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return
        if self.current_track and self.current_track.id == track_id and not self._stop_event.is_set():
            logger.info(f"[radio] play_now watchdog fired for track {track_id} — frontend missed 'ended'")
            await self.broadcast(WSMessage(event="play_now", data={"for_track_id": track_id}))

    def _start_play_now_watchdog(self, track: "TrackInfo") -> None:
        """Start (or restart) the watchdog for the given track."""
        self._cancel_play_now_watchdog()
        delay = float(track.duration + 3)
        self._play_now_task = asyncio.ensure_future(
            self._play_now_watchdog(track.id, delay)
        )
        logger.debug(f"[radio] play_now watchdog scheduled in {delay:.0f}s for '{track.song_title}'")

    def _cancel_play_now_watchdog(self) -> None:
        if self._play_now_task and not self._play_now_task.done():
            self._play_now_task.cancel()
        self._play_now_task = None

    def _purge_evicted_tracks(self) -> None:
        """Immediately evict tracks that have fallen out of the retention buffer.
        
        Replaces timer-based delay with a sliding-window approach (N=2).
        Guarantees audio_bytes are available for any track within the window,
        regardless of network jitter on mobile clients.
        Note: reaction_metadata_cache is intentionally excluded so users can react after tracks end."""
        active_ids = {t.id for t in [self.current_track, self.next_track] if t} | set(self._eviction_queue)
        
        for key in list(self.audio_cache.keys()):
            if key not in active_ids:
                self.audio_cache.pop(key)
                self.prompt_cache.pop(key, None)
                self.seed_cache.pop(key, None)
                self.track_info_cache.pop(key, None)

    async def stop(self) -> None:
        """Stop the radio session and clean up resources."""
        logger.info("[radio] Stop requested")
        self._stop_event.set()
        self._track_ended_event.set()      # Unblock waiting loop
        self._next_track_ready_event.set() # Unblock buffering wait

        self._cancel_play_now_watchdog()
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
        self.reaction_metadata_cache.clear()
        self.thumb_up_voters.clear()
        self.thumb_down_voters.clear()
        self.reaction_locks.clear()
        self._pending_settings = None
        logger.info("[radio] Session stopped and cleaned up")

    async def skip(self) -> None:
        """Skip the current track — signal the radio loop to advance."""
        logger.info("[radio] Skip requested — signalling track_ended")
        self._cancel_play_now_watchdog()
        self._track_ended_event.set()

    async def on_track_ended(self, finished_track_id: str | None = None) -> None:
        """Called when a client reports the current track has finished playing.

        finished_track_id: the track ID the client just finished. If provided and
        it no longer matches the current track, the signal is ignored as stale
        (handles async mobile clients signalling minutes after a pipeline advance).

        With N simultaneous listeners, only the first signal within
        _DEBOUNCE_S seconds is honoured; the rest are silently dropped to
        prevent N-1 spurious track advances.
        """
        # Track-ID guard: ignore stale signals from clients that are behind
        if finished_track_id and self.current_track and finished_track_id != self.current_track.id:
            logger.info(
                f"[radio] track_ended for {finished_track_id} but current is "
                f"{self.current_track.id} — ignoring stale signal"
            )
            return

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
        self._cancel_play_now_watchdog()
        self._track_ended_event.set()

    def get_current_best_track(self) -> "TrackInfo | None":
        """Return the best track for a client to play right now (non-blocking).

        A) next_track ready → return it (pipeline will advance on first track_ended)
        B) still generating → return current_track (client re-plays briefly)
        Returns None if no session is active.
        """
        if self.state not in (RadioState.PLAYING, RadioState.BUFFERING):
            return None
        if self.next_track is not None:
            return self.next_track
        return self.current_track

    # ------------------------------------------------------------------ #
    # WebSocket-gated control (called from WS handler in main.py)
    # ------------------------------------------------------------------ #

    async def start_from_ws(
        self, ws: WebSocket, genres: list[str], keywords: list[str],
        language: str = "en", feeling: str = "",
        advanced_options: dict | None = None,
        dj_name: str = "",
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
        self._dj_name = dj_name.strip()
        await self.start(genres, keywords, language, feeling, advanced_options)
        await self._broadcast_dj_state()

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
        """Update settings mid-session without interrupting in-flight generation.

        New settings are queued in _pending_settings and applied at the start of
        the next generation cycle (inside _start_prebuffer). This guarantees that
        any already-generating or already-buffered track plays to completion before
        the genre/keyword change takes effect, eliminating silent gaps on DJ transitions.

        Falls back to a full start() if not currently in a playing/buffering state.
        """
        if self.state not in (RadioState.PLAYING, RadioState.BUFFERING):
            logger.info("[radio] reschedule called but not playing — doing full start()")
            await self.start(genres, keywords, language, feeling, advanced_options)
            return

        logger.info(
            f"[radio] Rescheduling — new genres: {genres}, keywords: {keywords}, language: {language}"
        )

        # Queue the new settings; they will be applied when _start_prebuffer() next fires.
        # Overwrite any previously queued (but not yet applied) settings.
        self._pending_settings = {
            'genres': genres,
            'keywords': keywords,
            'language': language,
            'feeling': feeling,
            'advanced_options': advanced_options,
        }

        prebuffer_active = self._prebuffer_task and not self._prebuffer_task.done()

        if not prebuffer_active and self.next_track is None:
            # Nothing in the pipeline — apply immediately so we don't introduce extra delay
            self._apply_pending_settings()
            self._start_prebuffer()
            await self._broadcast_status("playing", "Settings updated — generating next track...")
        elif prebuffer_active:
            # In-flight generation continues with old settings; new settings apply next cycle
            logger.info("[radio] Prebuffer in-flight — settings queued, will apply after generation completes")
            await self._broadcast_status("playing", "Settings queued — current track finishing generation...")
        else:
            # next_track already buffered (old settings) — it plays next, then new settings kick in
            logger.info("[radio] Next track already buffered — settings queued, will apply on next generation")
            await self._broadcast_status("playing", "Settings queued — will apply on next generation...")

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

    def _apply_pending_settings(self) -> None:
        """Apply queued genre/keyword/language settings and reset history.

        Called from _start_prebuffer() so new settings take effect at the
        start of the next generation cycle rather than interrupting in-flight work.
        """
        ps = self._pending_settings
        self._pending_settings = None
        if ps is None:
            return
        genres = ps['genres']
        if genres == ['__random__']:
            self._random_genre = True
            self.genres = []
        else:
            self._random_genre = False
            self.genres = genres
        self.keywords, self._random_keyword_categories = _parse_keywords(ps['keywords'])
        self.language = ps['language']
        self.feeling = ps['feeling']
        ao = ps.get('advanced_options') or {}
        self.advanced_options = ao
        if ao:
            self._saved_advanced_options = dict(ao)
            self._DJ_LOCK_S = float(ao.get("djLockSeconds", self._DJ_LOCK_S))
        self.history = []
        logger.info(
            f"[radio] Applied queued settings — genres: {genres}, "
            f"keywords: {ps['keywords']}, language: {ps['language']}"
        )

    def _start_prebuffer(self) -> None:
        """Cancel any existing prebuffer task and start a fresh one.

        Applies any pending settings (queued by reschedule()) before starting
        so the new generation uses the correct genre/keywords.
        """
        self._cancel_prebuffer()
        if self._pending_settings:
            self._apply_pending_settings()
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

    async def _send_session_snapshot(self, ws: WebSocket) -> None:
        """Unicast current session state (track + status) to a newly connected client.

        Called for both controller and viewer after role_assigned is sent, so that
        late-joining clients see the current track immediately without waiting for
        the next broadcast cycle.
        """
        if self.state in (RadioState.IDLE, RadioState.STOPPED):
            return

        if self.current_track:
            await self._send_to(
                ws,
                WSMessage(
                    event="track_ready",
                    data={"track": self._make_track_dict(self.current_track), "isNext": False},
                ),
            )

        if self.next_track:
            await self._send_to(
                ws,
                WSMessage(
                    event="track_ready",
                    data={"track": self._make_track_dict(self.next_track), "isNext": True},
                ),
            )

        if self.state == RadioState.PLAYING:
            msg = "Playing — next track ready" if self.next_track else "Playing — generating next track..."
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
                data={"state": self.state.value, "message": msg, "nextReady": self.next_track is not None},
            ),
        )

    async def _send_controller_snapshot(self, ws: WebSocket) -> None:
        """Unicast role_assigned:controller + current session state to a newly connected controller."""
        await self._send_to(ws, WSMessage(event="role_assigned", data={"role": "controller"}))
        await self._send_to(ws, self._make_dj_state_message())
        await self._send_session_snapshot(ws)

    async def _send_viewer_snapshot(self, ws: WebSocket) -> None:
        """Unicast role_assigned:viewer + current session state to a newly connected viewer."""
        await self._send_to(ws, WSMessage(event="role_assigned", data={"role": "viewer"}))
        await self._send_to(ws, self._make_dj_state_message())
        await self._send_session_snapshot(ws)

    async def _promote_next_controller(self) -> None:
        """Promote the first local viewer to the controller role."""
        self._pending_promotion = False
        # Only local-network connections are eligible for the controller role
        new_controller = next(
            (ws for ws in self._ws_connections if self._ws_meta.get(ws, {}).get("is_local")),
            None,
        )
        if new_controller is None:
            logger.info("[radio] No local viewers to promote — controller slot is vacant")
            return
        self._controller_ws = new_controller
        logger.info("[radio] Local viewer promoted to controller")
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
            self._start_play_now_watchdog(current)

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
                    # Happy path: next track was pre-buffered. Advance pipeline
                    # and broadcast to all clients (web clients switch now;
                    # mobile clients that already pulled it via HTTP ignore this).
                    logger.info(
                        f"[radio] Next track was pre-buffered: '{self.next_track.song_title}' "
                        f"— advancing pipeline and notifying clients"
                    )
                    old_id = self.current_track.id if self.current_track else None
                    self.current_track = self.next_track
                    self.next_track = None
                    self._next_track_ready_event.clear()
                    if old_id:
                        self._eviction_queue.append(old_id)
                        self._purge_evicted_tracks()
                        logger.debug(f"[radio] Scheduled deferred eviction for: {old_id}")
                    self.state = RadioState.PLAYING
                    await self._broadcast_track_ready(self.current_track, is_next=False)
                    await self._broadcast_status("playing", "Playing — generating next track...")
                    if self.current_track:
                        self._start_play_now_watchdog(self.current_track)
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
                        self._eviction_queue.append(old_id)
                        self._purge_evicted_tracks()
                        logger.debug(f"[radio] Scheduled deferred eviction for: {old_id}")
                    self.state = RadioState.PLAYING

                    logger.info(f"[radio] Buffering done — now playing: '{track.song_title}'")
                    await self._broadcast_track_ready(track, is_next=False)
                    await self._broadcast_status("playing", "Playing — generating next track...")
                    self._start_play_now_watchdog(track)

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

            # Next track is held silently — clients pull it via HTTP when ready.
            # No push broadcast: each client fetches on its own schedule.

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
        # Snapshot DJ name now so a mid-generation DJ change doesn't bleed into this track's title
        dj_name_for_track = self._dj_name
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

        logger.info(
            f"[radio] [{short_id}] Keywords for LLM: {keywords_for_llm or 'none'}"
        )
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
                use_cot_caption=opts.get("useCotCaption", True),
                use_cot_metas=opts.get("useCotMetas", True),
                use_cot_language=opts.get("useCotLanguage", True),
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
            dj_name=dj_name_for_track,
            dj_keywords=list(self.keywords),
            dj_language=self.language,
        )

        self.track_info_cache[track_id] = track_info

        # Snapshot everything needed to write the reaction JSON file later.
        # Stored separately from track_info_cache/audio_cache so it survives
        # the track-transition eviction and is available even after the track ends.
        self.reaction_metadata_cache[track_id] = {
            "trackId": track_id,
            "songTitle": track_info.song_title,
            "genre": track_info.genre,
            "bpm": track_info.bpm,
            "keyScale": track_info.key_scale,
            "duration": track_info.duration,
            "language": self.language,
            "keywords": list(self.keywords),
            "tags": song_prompt.tags,
            "lyrics": song_prompt.lyrics,
            "style": song_prompt.style,
            "instruments": song_prompt.instruments,
            "mood": song_prompt.mood,
            "vocalStyle": song_prompt.vocal_style,
            "production": song_prompt.production,
            "djName": dj_name_for_track,
            # Audio bytes are stored here so the MP3 can be written to disk on first
            # reaction even if audio_cache has already been evicted.
            "_audio_bytes": audio_bytes,
        }

        return track_info

    # ------------------------------------------------------------------ #
    # Reactions (thumb up / thumb down)
    # ------------------------------------------------------------------ #

    async def react(
        self,
        track_id: str,
        action: str,
        client_ip: str,
        reactions_dir: Path,
    ) -> dict:
        """Toggle a thumb_up or thumb_down reaction for a client IP.

        Returns {"thumb_up": int, "thumb_down": int, "userReaction": str | None}.
        Raises ValueError if no track metadata is available to create a new record.
        """
        if track_id not in self.reaction_locks:
            self.reaction_locks[track_id] = asyncio.Lock()
        if track_id not in self.thumb_up_voters:
            self.thumb_up_voters[track_id] = set()
        if track_id not in self.thumb_down_voters:
            self.thumb_down_voters[track_id] = set()

        async with self.reaction_locks[track_id]:
            up = self.thumb_up_voters[track_id]
            down = self.thumb_down_voters[track_id]

            if action == "thumb_up":
                if client_ip in up:
                    up.discard(client_ip)
                    new_reaction = None
                else:
                    up.add(client_ip)
                    down.discard(client_ip)
                    new_reaction = "thumb_up"
            else:  # thumb_down
                if client_ip in down:
                    down.discard(client_ip)
                    new_reaction = None
                else:
                    down.add(client_ip)
                    up.discard(client_ip)
                    new_reaction = "thumb_down"

            counts = {"thumb_up": len(up), "thumb_down": len(down)}
            await self._write_reaction_file(track_id, counts, reactions_dir)

        await self.broadcast(WSMessage(
            event="reaction_update",
            data={"trackId": track_id, "thumbUp": counts["thumb_up"], "thumbDown": counts["thumb_down"]},
        ))
        return {**counts, "userReaction": new_reaction}

    async def _write_reaction_file(
        self, track_id: str, counts: dict, reactions_dir: Path
    ) -> None:
        """Create or update the track's reaction JSON file on disk."""
        reactions_dir.mkdir(exist_ok=True)
        json_path = reactions_dir / f"{track_id}.json"
        loop = asyncio.get_event_loop()

        if json_path.exists():
            existing = json.loads(json_path.read_text(encoding="utf-8"))
            existing["thumb_up"] = counts["thumb_up"]
            existing["thumb_down"] = counts["thumb_down"]
            data = existing
        else:
            meta = self.reaction_metadata_cache.get(track_id)
            if not meta:
                logger.warning(f"[radio] reaction_metadata_cache miss for {track_id} — cannot create file")
                raise ValueError("Track metadata unavailable — too late to react")

            # Save MP3 alongside the JSON so the record is self-contained
            audio_bytes: bytes = meta.get("_audio_bytes") or self.audio_cache.get(track_id, b"")
            mp3_path = reactions_dir / f"{track_id}.mp3"
            if audio_bytes:
                await loop.run_in_executor(None, mp3_path.write_bytes, audio_bytes)
                audio_path = str(mp3_path.resolve())
            else:
                logger.warning(f"[radio] Audio bytes unavailable for {track_id} — skipping MP3 write")
                audio_path = ""

            data = {k: v for k, v in meta.items() if not k.startswith("_")}
            data["recordedAt"] = datetime.utcnow().isoformat()
            data["audioPath"] = audio_path
            data["thumb_up"] = counts["thumb_up"]
            data["thumb_down"] = counts["thumb_down"]

        json_text = json.dumps(data, indent=2, ensure_ascii=False)
        await loop.run_in_executor(None, json_path.write_text, json_text, "utf-8")
        logger.debug(
            f"[radio] Reaction file updated: {json_path.name} — "
            f"up={counts['thumb_up']}, down={counts['thumb_down']}"
        )

    async def get_reactions(
        self, track_id: str, client_ip: str, reactions_dir: Path
    ) -> dict:
        """Return current reaction counts and the caller's vote for a track."""
        up = len(self.thumb_up_voters.get(track_id, set()))
        down = len(self.thumb_down_voters.get(track_id, set()))

        if client_ip in self.thumb_up_voters.get(track_id, set()):
            user_reaction = "thumb_up"
        elif client_ip in self.thumb_down_voters.get(track_id, set()):
            user_reaction = "thumb_down"
        else:
            user_reaction = None

        # Fall back to file counts if in-memory is zero (e.g. after server restart)
        if up == 0 and down == 0:
            json_path = reactions_dir / f"{track_id}.json"
            if json_path.exists():
                try:
                    saved = json.loads(json_path.read_text(encoding="utf-8"))
                    up = saved.get("thumb_up", 0)
                    down = saved.get("thumb_down", 0)
                except Exception:
                    pass

        return {"thumb_up": up, "thumb_down": down, "userReaction": user_reaction}

    # ------------------------------------------------------------------ #
    # DJ mode
    # ------------------------------------------------------------------ #

    def _make_dj_state_message(self) -> WSMessage:
        """Build the current dj_state WSMessage (for broadcast or unicast)."""
        now = time.time()
        return WSMessage(
            event="dj_state",
            data={
                "locked": now < self._dj_lock_until,
                "unlockAt": self._dj_lock_until,
                "activeDjName": self._dj_name,
            },
        )

    async def _broadcast_dj_state(self) -> None:
        await self.broadcast(self._make_dj_state_message())

    async def claim_dj_from_ws(self, ws: WebSocket) -> None:
        """First-click-wins claim. Safe: no await between guard check and mutation."""
        now = time.time()
        if now < self._dj_lock_until or self._dj_claimant_ws is not None:
            await self._send_to(ws, WSMessage(event="dj_claim_ack", data={"granted": False}))
            return
        # Atomic claim: assign before any await
        self._dj_claimant_ws = ws
        self._dj_lock_until = now + self._DJ_LOCK_S  # re-lock immediately for all others
        logger.info("[radio] DJ slot claimed")
        await self._send_to(ws, WSMessage(event="dj_claim_ack", data={"granted": True}))
        await self._broadcast_dj_state()

    async def submit_dj_from_ws(
        self,
        ws: WebSocket,
        genres: list[str],
        keywords: list[str],
        language: str,
        feeling: str,
        dj_name: str,
    ) -> None:
        """Apply DJ's selections via the existing reschedule pathway."""
        if ws != self._dj_claimant_ws:
            logger.warning("[radio] dj_submit rejected — sender is not the current claimant")
            return
        self._dj_name = dj_name.strip()
        self._dj_claimant_ws = None
        logger.info(f"[radio] DJ submitted: name={self._dj_name!r}, genres={genres}, language={language}")
        await self.reschedule(genres, keywords, language, feeling, advanced_options=None)
        await self._broadcast_dj_state()

    # ------------------------------------------------------------------ #
    # WebSocket broadcast helpers
    # ------------------------------------------------------------------ #

    def _make_track_dict(self, track: TrackInfo) -> dict:
        return {
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
            "djName": track.dj_name,
            "djKeywords": track.dj_keywords,
            "djLanguage": track.dj_language,
        }

    async def _broadcast_track_ready(self, track: TrackInfo, is_next: bool) -> None:
        label = "next (pre-buffered)" if is_next else "current (play now)"
        in_cache = track.id in self.audio_cache
        logger.info(
            f"[radio] Broadcasting track_ready — '{track.song_title}' [{label}] | "
            f"track_id={track.id} | audio_url={track.audio_url} | "
            f"in_audio_cache={in_cache}"
        )
        await self.broadcast(WSMessage(event="track_ready", data={"track": self._make_track_dict(track), "isNext": is_next}))

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
