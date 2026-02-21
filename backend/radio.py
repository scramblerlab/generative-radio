import asyncio
import contextlib
import logging
import time
import uuid

from fastapi import WebSocket
from models import RadioState, TrackInfo, WSMessage, SongPrompt
from llm import OllamaClient
from acestep_client import ACEStepClient
from config import mem_snapshot

logger = logging.getLogger(__name__)


class RadioOrchestrator:
    def __init__(self, llm: OllamaClient, acestep: ACEStepClient):
        self.llm = llm
        self.acestep = acestep

        # State
        self.state: RadioState = RadioState.IDLE
        self.genres: list[str] = []
        self.keywords: list[str] = []
        self.history: list[str] = []          # Song titles played this session

        # Track management
        self.current_track: TrackInfo | None = None
        self.next_track: TrackInfo | None = None   # Pre-buffered; already sent to frontend as isNext=True
        self.audio_cache: dict[str, bytes] = {}    # track_id → raw MP3 bytes

        # Async primitives
        self._task: asyncio.Task | None = None
        self._prebuffer_task: asyncio.Task | None = None  # Background generation task
        self._stop_event = asyncio.Event()
        self._track_ended_event = asyncio.Event()
        self._next_track_ready_event = asyncio.Event()

        # WebSocket connections
        self._ws_connections: list[WebSocket] = []

    # ------------------------------------------------------------------ #
    # WebSocket connection management
    # ------------------------------------------------------------------ #

    def add_ws(self, ws: WebSocket) -> None:
        self._ws_connections.append(ws)
        logger.info(f"[radio] WS connected — total connections: {len(self._ws_connections)}")

    def remove_ws(self, ws: WebSocket) -> None:
        if ws in self._ws_connections:
            self._ws_connections.remove(ws)
        logger.info(f"[radio] WS disconnected — total connections: {len(self._ws_connections)}")

    # ------------------------------------------------------------------ #
    # Public control methods
    # ------------------------------------------------------------------ #

    async def start(self, genres: list[str], keywords: list[str]) -> None:
        """Start a new radio session, stopping any existing one first."""
        if self._task and not self._task.done():
            logger.info("[radio] Stopping existing session before starting new one")
            await self.stop()

        self.genres = genres
        self.keywords = keywords
        self.history = []
        self.next_track = None
        self._stop_event.clear()
        self._track_ended_event.clear()
        self._next_track_ready_event.clear()
        self.audio_cache.clear()

        logger.info(f"[radio] Starting session — genres: {genres}, keywords: {keywords}")
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
        logger.info("[radio] Session stopped and cleaned up")

    async def skip(self) -> None:
        """Skip the current track — signal the radio loop to advance."""
        logger.info("[radio] Skip requested — signalling track_ended")
        self._track_ended_event.set()

    async def on_track_ended(self) -> None:
        """Called when the frontend reports the current track has finished playing."""
        logger.info("[radio] Track-ended signal received from client")
        self._track_ended_event.set()

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
                        logger.debug(f"[radio] Evicted audio cache for finished track: {old_id}")
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
                        logger.debug(f"[radio] Evicted audio cache for finished track: {old_id}")
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
        logger.info(
            f"[radio] [{short_id}] Starting track generation "
            f"(session history: {len(self.history)} songs)"
        )

        # Step 1: LLM generates a structured song prompt
        await self._broadcast_progress("llm_thinking", "DJ is writing the next song prompt…")
        logger.info(f"[radio] [{short_id}] Before LLM    — {mem_snapshot()}")
        logger.info(f"[radio] [{short_id}] Calling LLM for song prompt...")
        t_llm = time.monotonic()
        song_prompt: SongPrompt = await self.llm.generate_prompt(
            self.genres, self.keywords, self.history
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
        logger.info(f"[radio] [{short_id}] Sending to ACE-Step...")
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
            audio_bytes, _metadata = await self.acestep.generate_song(song_prompt)
        finally:
            _progress_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await _progress_task

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
        logger.info(f"[radio] [{short_id}] Cached as track_id: {track_id}")

        # Keep session history bounded (last 20 titles)
        self.history.append(song_prompt.song_title)
        if len(self.history) > 20:
            self.history = self.history[-20:]

        return TrackInfo(
            id=track_id,
            song_title=song_prompt.song_title,
            tags=song_prompt.tags,
            lyrics=song_prompt.lyrics,
            bpm=song_prompt.bpm,
            key_scale=song_prompt.key_scale,
            duration=song_prompt.duration,
            audio_url=f"/api/audio/{track_id}",
        )

    # ------------------------------------------------------------------ #
    # WebSocket broadcast helpers
    # ------------------------------------------------------------------ #

    async def _broadcast_track_ready(self, track: TrackInfo, is_next: bool) -> None:
        track_dict = {
            "id": track.id,
            "songTitle": track.song_title,
            "tags": track.tags,
            "lyrics": track.lyrics,
            "bpm": track.bpm,
            "keyScale": track.key_scale,
            "duration": track.duration,
            "audioUrl": track.audio_url,
        }
        label = "next (pre-buffered)" if is_next else "current (play now)"
        logger.info(f"[radio] Broadcasting track_ready — '{track.song_title}' [{label}]")
        await self.broadcast(
            WSMessage(event="track_ready", data={"track": track_dict, "isNext": is_next})
        )

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
