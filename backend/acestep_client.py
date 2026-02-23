import asyncio
import json
import logging
import time
from urllib.parse import urlparse, parse_qs

import httpx
from models import SongPrompt

logger = logging.getLogger(__name__)

ACESTEP_BASE_URL = "http://localhost:8001"
POLL_INTERVAL_S = 2.0
TASK_TIMEOUT_S = 300.0  # 5 minutes max per track


class ACEStepClient:
    def __init__(self, base_url: str = ACESTEP_BASE_URL):
        self.base_url = base_url
        self.client = httpx.AsyncClient(base_url=base_url, timeout=TASK_TIMEOUT_S)
        logger.info(f"[acestep] ACEStepClient initialized — base_url: {base_url}")

    async def health_check(self) -> bool:
        """GET /health — verify ACE-Step API is running."""
        try:
            resp = await self.client.get("/health", timeout=5.0)
            ok = resp.status_code == 200
            if ok:
                logger.info("[acestep] Health check: OK")
            else:
                logger.warning(f"[acestep] Health check: FAILED (HTTP {resp.status_code})")
            return ok
        except Exception as e:
            logger.error(f"[acestep] Health check failed — is ACE-Step running on {self.base_url}? Error: {e}")
            return False

    async def submit_task(self, prompt: SongPrompt, vocal_language: str = "en") -> str:
        """POST /release_task — submit a music generation job, return task_id.

        vocal_language: ISO 639-1 code (e.g. "en", "ja", "ko"), or "unknown" for
        auto-detection / instrumental tracks.
        """
        # "instrumental" is our internal sentinel; ACE-Step uses "unknown"
        ace_language = "unknown" if vocal_language == "instrumental" else vocal_language
        payload = {
            "prompt": prompt.tags,
            "lyrics": prompt.lyrics,
            "bpm": prompt.bpm,
            "key_scale": prompt.key_scale,
            "audio_duration": prompt.duration,
            "vocal_language": ace_language,
            "thinking": True,       # ACE-Step's internal LM-DiT enhanced quality mode
            "batch_size": 1,
            "audio_format": "mp3",
            "inference_steps": 8,   # Turbo: fast with good quality
            "use_random_seed": True,
        }
        logger.info(
            f"[acestep] '{prompt.song_title}' — submitting task "
            f"(bpm: {prompt.bpm}, key: {prompt.key_scale}, duration: {prompt.duration}s)"
        )
        logger.debug(f"[acestep] '{prompt.song_title}' tags: {prompt.tags[:100]}")
        logger.debug(f"[acestep] '{prompt.song_title}' lyrics preview: {prompt.lyrics[:80].replace(chr(10), ' ')}")

        try:
            resp = await self.client.post("/release_task", json=payload)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            logger.error(
                f"[acestep] '{prompt.song_title}' — submit HTTP error: "
                f"{e.response.status_code} — {e.response.text}"
            )
            raise
        except Exception as e:
            logger.error(f"[acestep] '{prompt.song_title}' — submit failed: {e}", exc_info=True)
            raise

        data = resp.json()
        task_id: str = data["data"]["task_id"]
        logger.info(f"[acestep] '{prompt.song_title}' — task submitted (task_id: {task_id})")
        return task_id

    async def poll_task(
        self,
        task_id: str,
        song_title: str = "",
        interval: float = POLL_INTERVAL_S,
    ) -> dict:
        """POST /query_result — poll until the task succeeds or fails.

        IMPORTANT: The 'result' field in the ACE-Step response is a JSON STRING
        that must be parsed a second time with json.loads().
        """
        label = f"'{song_title}' " if song_title else ""
        logger.info(f"[acestep] {label}— polling task {task_id} every {interval}s...")
        poll_count = 0
        t0 = time.monotonic()

        while True:
            try:
                resp = await self.client.post(
                    "/query_result", json={"task_id_list": [task_id]}
                )
                resp.raise_for_status()
            except Exception as e:
                logger.warning(f"[acestep] {label}— poll request failed (will retry): {e}")
                await asyncio.sleep(interval)
                continue

            data = resp.json()
            item = data["data"][0]
            status: int = item["status"]
            poll_count += 1
            elapsed = time.monotonic() - t0

            # Log progress every 10 seconds
            if poll_count == 1 or elapsed % 10 < interval:
                logger.info(
                    f"[acestep] {label}— "
                    f"status: {'running' if status == 0 else 'done'}, "
                    f"elapsed: {elapsed:.0f}s, polls: {poll_count}"
                )

            if status == 1:
                logger.info(
                    f"[acestep] {label}— SUCCEEDED "
                    f"(total: {elapsed:.1f}s, polls: {poll_count})"
                )
                # result is a JSON string — must be parsed again
                result_list: list[dict] = json.loads(item["result"])
                return result_list[0]

            elif status == 2:
                logger.error(f"[acestep] {label}— task FAILED after {elapsed:.1f}s")
                raise RuntimeError(f"ACE-Step task failed (task_id={task_id})")

            if elapsed > TASK_TIMEOUT_S:
                logger.error(f"[acestep] {label}— task timed out after {elapsed:.0f}s")
                raise TimeoutError(f"ACE-Step task timed out (task_id={task_id})")

            await asyncio.sleep(interval)

    async def get_audio_bytes(self, audio_path: str, song_title: str = "") -> bytes:
        """GET /v1/audio?path=<audio_path> — download generated audio."""
        label = f"'{song_title}' " if song_title else ""
        logger.info(f"[acestep] {label}— downloading audio: {audio_path}")
        try:
            resp = await self.client.get("/v1/audio", params={"path": audio_path})
            resp.raise_for_status()
        except Exception as e:
            logger.error(f"[acestep] {label}— audio download failed: {e}", exc_info=True)
            raise

        size_kb = len(resp.content) / 1024
        logger.info(f"[acestep] {label}— downloaded {size_kb:.1f} KB")
        return resp.content

    async def close(self) -> None:
        """Close the underlying HTTP client and release connections."""
        await self.client.aclose()
        logger.info("[acestep] HTTP client closed")

    async def generate_song(self, prompt: SongPrompt, vocal_language: str = "en") -> tuple[bytes, dict]:
        """Full pipeline: submit → poll → download.

        Returns (audio_bytes, result_metadata).
        """
        logger.info(f"[acestep] ── Starting pipeline for '{prompt.song_title}' (lang: {vocal_language}) ──")
        t0 = time.monotonic()

        task_id = await self.submit_task(prompt, vocal_language=vocal_language)
        result = await self.poll_task(task_id, song_title=prompt.song_title)

        # Parse the audio path from the file URL field
        # result["file"] looks like: "/v1/audio?path=%2Ftmp%2Fapi_audio%2Fabc.mp3"
        file_url: str = result["file"]
        parsed = urlparse(file_url)
        path_param = parse_qs(parsed.query).get("path", [""])[0]
        logger.debug(f"[acestep] '{prompt.song_title}' — audio path: {path_param}")

        audio_bytes = await self.get_audio_bytes(path_param, song_title=prompt.song_title)

        total = time.monotonic() - t0
        logger.info(
            f"[acestep] ── Pipeline complete for '{prompt.song_title}' "
            f"— total: {total:.1f}s ──"
        )
        return audio_bytes, result
