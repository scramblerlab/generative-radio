from pydantic import BaseModel, Field, field_validator
from enum import Enum

MAX_DURATION_S = 60  # MLX VAE needs <14.3GB; 90s→15.6GB fails, 60s→9.7GB passes


class RadioState(str, Enum):
    IDLE = "idle"
    GENERATING = "generating"
    PLAYING = "playing"
    BUFFERING = "buffering"
    STOPPED = "stopped"


class SongPrompt(BaseModel):
    """Structured output from the Ollama LLM DJ brain."""
    song_title: str = Field(description="Creative title for the song")
    tags: str = Field(description="Comma-separated music style tags for ACE-Step")
    lyrics: str = Field(description="Song lyrics with [verse], [chorus], [bridge] markers")
    bpm: int = Field(description="Tempo in BPM", ge=60, le=200)
    key_scale: str = Field(description="Musical key, e.g. 'C Major', 'Am', 'F# Minor'")
    duration: int = Field(description="Song duration in seconds", ge=30, le=MAX_DURATION_S)

    @field_validator("duration")
    @classmethod
    def clamp_duration(cls, v: int) -> int:
        """Hard cap — MLX VAE requires a single Metal buffer; 60s fits (9.7GB),
        90s does not (15.6GB > 14.3GB M3 limit) causing a slow PyTorch fallback."""
        return min(v, MAX_DURATION_S)


class TrackInfo(BaseModel):
    """Track metadata sent to the frontend."""
    id: str
    song_title: str
    tags: str
    lyrics: str
    bpm: int
    key_scale: str
    duration: int
    audio_url: str  # Proxied URL: /api/audio/{id}


class RadioStartRequest(BaseModel):
    genres: list[str]
    keywords: list[str] = []


class WSMessage(BaseModel):
    event: str  # "track_ready" | "status" | "error"
    data: dict
