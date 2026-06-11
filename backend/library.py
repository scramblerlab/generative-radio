"""Persistent track library — instant-start replays + ACE-Step output adoption.

ACE-Step's API server writes every generated MP3 to ``<tmp_root>/api_audio``
(on this machine: ``/Volumes/SP PCIe M.2/ACE-Step/api_audio``) and never prunes
it. The radio backend downloads the bytes over HTTP and historically left the
file behind forever.

This module makes the radio the owner of those files instead:

* ``adopt()``   — moves (``os.rename``, atomic on the same volume) the original
  MP3 into the library directory and writes a JSON metadata sidecar next to it.
  No duplicate copies are ever made.
* ``pick()``    — returns a random library entry (preferring genre matches) so a
  session can start playing instantly while the first fresh track generates.
* janitor       — periodically deletes orphaned ``api_audio`` MP3s (failed /
  abandoned tasks, warmup output) older than a TTL.

If the library volume is not mounted the library disables itself and the radio
behaves exactly as before.
"""

import asyncio
import json
import logging
import os
import random
import shutil
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

DEFAULT_LIBRARY_DIR = "/Volumes/SP PCIe M.2/generative-radio/library"
# ACE-Step writes generated MP3s under <tmp_root>/api_audio; without
# ACESTEP_TMPDIR that is <ACE-Step clone>/.cache/acestep/tmp/api_audio.
# The janitor retargets itself from real adopted file paths, so this default
# only matters for the first sweep after a restart.
DEFAULT_API_AUDIO_DIR = str(
    Path(__file__).resolve().parent.parent.parent
    / "ACE-Step-1.5" / ".cache" / "acestep" / "tmp" / "api_audio"
)

LIBRARY_MAX_TRACKS = int(os.getenv("LIBRARY_MAX_TRACKS", "500"))
API_AUDIO_ORPHAN_TTL_H = float(os.getenv("API_AUDIO_ORPHAN_TTL_H", "48"))
_JANITOR_INTERVAL_S = 24 * 3600
_RECENT_PICKS_N = 8  # don't replay the same track again within this many picks


class TrackLibrary:
    def __init__(
        self,
        library_dir: str | None = None,
        api_audio_dir: str | None = None,
        max_tracks: int = LIBRARY_MAX_TRACKS,
    ):
        self.dir = Path(library_dir or os.getenv("LIBRARY_DIR", DEFAULT_LIBRARY_DIR))
        env_api_audio = api_audio_dir or os.getenv("ACESTEP_API_AUDIO_DIR")
        self.api_audio_dir = Path(env_api_audio or DEFAULT_API_AUDIO_DIR)
        # When no explicit override is given, the janitor retargets itself to the
        # real api_audio directory observed on the first adopt() — ACE-Step's
        # tmp_root depends on ACESTEP_TMPDIR / cache_root and can differ per setup.
        self._api_audio_pinned = env_api_audio is not None
        self.max_tracks = max_tracks
        self.enabled = False
        self._index: dict[str, dict] = {}  # track_id → sidecar metadata
        self._recent_picks: deque[str] = deque(maxlen=_RECENT_PICKS_N)
        self._janitor_task: asyncio.Task | None = None

        # Never mkdir through an unmounted /Volumes mount point — that would
        # create a phantom directory on the boot volume that masks the SSD.
        if len(self.dir.parts) > 2 and self.dir.parts[1] == "Volumes":
            volume_root = Path(*self.dir.parts[:3])
            if not volume_root.is_dir():
                logger.warning(
                    f"[library] Volume {volume_root} is not mounted — library disabled; "
                    f"radio falls back to generate-and-wait behaviour"
                )
                return

        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            self.enabled = True
        except OSError as e:
            logger.warning(
                f"[library] Cannot create {self.dir} ({e}) — library disabled; "
                f"radio falls back to generate-and-wait behaviour"
            )
            return

        self._load_index()
        logger.info(
            f"[library] Initialized — {len(self._index)} tracks in {self.dir} "
            f"(cap: {self.max_tracks})"
        )

    # ------------------------------------------------------------------ #
    # Index
    # ------------------------------------------------------------------ #

    def _load_index(self) -> None:
        for sidecar in self.dir.glob("*.json"):
            try:
                meta = json.loads(sidecar.read_text(encoding="utf-8"))
                track_id = meta.get("trackId")
                if track_id and (self.dir / f"{track_id}.mp3").exists():
                    self._index[track_id] = meta
            except Exception as e:
                logger.warning(f"[library] Skipping unreadable sidecar {sidecar.name}: {e}")

    def __len__(self) -> int:
        return len(self._index)

    # ------------------------------------------------------------------ #
    # Adopt (move ACE-Step's original file — never copy)
    # ------------------------------------------------------------------ #

    async def adopt(
        self,
        track_id: str,
        acestep_file_path: str,
        metadata: dict,
        audio_bytes: bytes | None = None,
    ) -> bool:
        """Take ownership of a generated track.

        Moves the ACE-Step original into the library and writes the sidecar.
        Falls back to writing ``audio_bytes`` if the source file is gone.
        Idempotent: an existing library entry for track_id is left untouched.
        """
        if not self.enabled:
            return False
        if track_id in self._index and (self.dir / f"{track_id}.mp3").exists():
            return True
        try:
            return await asyncio.to_thread(
                self._adopt_sync, track_id, acestep_file_path, metadata, audio_bytes
            )
        except Exception as e:
            logger.warning(f"[library] adopt failed for {track_id}: {e}")
            return False

    def _adopt_sync(
        self,
        track_id: str,
        acestep_file_path: str,
        metadata: dict,
        audio_bytes: bytes | None,
    ) -> bool:
        dst = self.dir / f"{track_id}.mp3"
        src = Path(acestep_file_path) if acestep_file_path else None

        if src and src.is_file():
            if not self._api_audio_pinned and src.parent != self.api_audio_dir:
                logger.info(f"[library] api_audio located at {src.parent} — janitor retargeted")
                self.api_audio_dir = src.parent
                self._api_audio_pinned = True
            try:
                os.rename(src, dst)  # atomic when library shares the volume
            except OSError:
                shutil.move(str(src), str(dst))  # cross-volume fallback
        elif audio_bytes:
            logger.info(
                f"[library] Source file missing for {track_id} "
                f"({acestep_file_path!r}) — writing cached bytes instead"
            )
            dst.write_bytes(audio_bytes)
        else:
            logger.warning(f"[library] Nothing to adopt for {track_id}")
            return False

        meta = dict(metadata)
        meta["trackId"] = track_id
        meta.setdefault("createdAt", datetime.now(timezone.utc).isoformat())
        meta["acestepFile"] = src.name if src else ""
        sidecar = self.dir / f"{track_id}.json"
        sidecar.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")

        self._index[track_id] = meta
        logger.info(
            f"[library] Adopted '{meta.get('songTitle', '?')}' "
            f"({track_id}) — {len(self._index)} tracks"
        )
        self._enforce_cap()
        return True

    def _enforce_cap(self) -> None:
        while len(self._index) > self.max_tracks:
            oldest_id = min(
                self._index, key=lambda tid: self._index[tid].get("createdAt", "")
            )
            self._index.pop(oldest_id, None)
            for suffix in (".mp3", ".json"):
                path = self.dir / f"{oldest_id}{suffix}"
                try:
                    path.unlink(missing_ok=True)
                except OSError as e:
                    logger.warning(f"[library] Could not evict {path.name}: {e}")
            logger.info(f"[library] Cap {self.max_tracks} reached — evicted oldest track {oldest_id}")

    # ------------------------------------------------------------------ #
    # Pick + load (instant-start replays)
    # ------------------------------------------------------------------ #

    def pick(self, genre_ids: list[str]) -> dict | None:
        """Random library entry, preferring tracks sharing a genre with the session.

        Avoids the last few picked tracks. Returns the sidecar metadata dict.
        """
        if not self.enabled or not self._index:
            return None

        candidates = list(self._index.values())
        if genre_ids:
            wanted = set(genre_ids)
            matching = [m for m in candidates if wanted & set(m.get("genres", []))]
            if matching:
                candidates = matching

        fresh = [m for m in candidates if m["trackId"] not in self._recent_picks]
        pool = fresh or candidates
        choice = random.choice(pool)
        self._recent_picks.append(choice["trackId"])
        logger.info(
            f"[library] Picked '{choice.get('songTitle', '?')}' "
            f"({choice['trackId']}) from {len(pool)} candidate(s)"
        )
        return choice

    async def load_audio(self, track_id: str) -> bytes | None:
        if not self.enabled:
            return None
        path = self.dir / f"{track_id}.mp3"
        try:
            return await asyncio.to_thread(path.read_bytes)
        except OSError as e:
            logger.warning(f"[library] Could not read {path.name}: {e}")
            self._index.pop(track_id, None)
            return None

    # ------------------------------------------------------------------ #
    # api_audio janitor
    # ------------------------------------------------------------------ #

    def start_janitor(self) -> None:
        """Daily sweep of orphaned api_audio MP3s older than API_AUDIO_ORPHAN_TTL_H.

        Successful tracks are moved out by adopt(); anything left behind is a
        failed/abandoned task or warmup output. Disable with API_AUDIO_JANITOR=0.
        """
        if os.getenv("API_AUDIO_JANITOR", "1") != "1":
            logger.info("[library] api_audio janitor disabled via API_AUDIO_JANITOR=0")
            return
        self._janitor_task = asyncio.create_task(self._janitor_loop(), name="library-janitor")

    async def _janitor_loop(self) -> None:
        while True:
            try:
                removed, freed_mb = await asyncio.to_thread(self._sweep_orphans)
                if removed:
                    logger.info(
                        f"[library] Janitor removed {removed} orphaned api_audio file(s) "
                        f"({freed_mb:.0f} MB freed)"
                    )
            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.warning(f"[library] Janitor sweep failed: {e}")
            await asyncio.sleep(_JANITOR_INTERVAL_S)

    def _sweep_orphans(self) -> tuple[int, float]:
        if not self.api_audio_dir.is_dir():
            return 0, 0.0
        cutoff = time.time() - API_AUDIO_ORPHAN_TTL_H * 3600
        removed = 0
        freed = 0
        for f in self.api_audio_dir.glob("*.mp3"):
            try:
                stat = f.stat()
                if stat.st_mtime < cutoff:
                    f.unlink()
                    removed += 1
                    freed += stat.st_size
            except OSError:
                continue
        return removed, freed / (1024 * 1024)

    def stop_janitor(self) -> None:
        if self._janitor_task and not self._janitor_task.done():
            self._janitor_task.cancel()
        self._janitor_task = None
