from pydantic import BaseModel, Field, field_validator
from enum import Enum

from config import MAX_DURATION_S  # set at startup based on unified memory (see config.py)


class RadioState(str, Enum):
    IDLE = "idle"
    GENERATING = "generating"
    PLAYING = "playing"
    BUFFERING = "buffering"
    STOPPED = "stopped"


class SongPrompt(BaseModel):
    """Structured output from the Ollama LLM DJ brain.

    Caption is split into 5 dimension fields covering ACE-Step's 9 recommended
    caption dimensions.  See docs/llm-prompt-improvement-plan.md for rationale.
    """
    song_title: str = Field(description="Creative title for the song")
    style: str = Field(default="", description="Genre, sub-genre, and optional era reference (e.g. 'smooth jazz, bebop influences, late-night club')")
    instruments: str = Field(default="", description="Key instruments featured in the track (e.g. 'mellow saxophone, soft piano, upright bass')")
    mood: str = Field(default="", description="Emotion, atmosphere, and timbre texture (e.g. 'warm, intimate, nostalgic, smoky, lush')")
    vocal_style: str = Field(default="", description="Vocal gender, timbre, and technique; empty string for instrumental (e.g. 'female vocal, breathy, soft')")
    production: str = Field(default="", description="Production style, rhythm feel, and structure hints (e.g. 'lo-fi, bedroom pop, laid-back groove')")
    lyrics: str = Field(default="", description="Song lyrics with structure tags like [Intro], [Verse], [Pre-Chorus], [Chorus], [Bridge], [Outro], [Fade Out]")
    bpm: int = Field(default=90, description="Tempo in BPM", ge=30, le=300)
    key_scale: str = Field(default="C Major", description="Musical key, e.g. 'C Major', 'Am', 'F# Minor'")
    duration: int = Field(default=60, description="Song duration in seconds")

    @property
    def tags(self) -> str:
        """Concatenate all dimension fields into a single comma-separated caption string."""
        return ", ".join(filter(None, [self.style, self.instruments, self.mood, self.vocal_style, self.production]))

    @field_validator("bpm", "duration", mode="before")
    @classmethod
    def coerce_numeric_to_int(cls, v):
        """Round fractional floats to int — qwen3.5 sometimes outputs e.g. 58.5."""
        if isinstance(v, float):
            return round(v)
        return v

    @field_validator("lyrics")
    @classmethod
    def ensure_fade_out(cls, v: str) -> str:
        """Guarantee [Fade Out] is present — belt-and-suspenders if the LLM forgets."""
        if v and "[Fade Out]" not in v:
            return v.rstrip() + "\n\n[Fade Out]"
        return v

    @field_validator("duration")
    @classmethod
    def clamp_duration(cls, v: int) -> int:
        """Clamp to [30, MAX_DURATION_S] — safety net in case the LLM ignores the prompt."""
        return max(30, min(v, MAX_DURATION_S))


class TrackInfo(BaseModel):
    """Track metadata sent to the frontend."""
    id: str
    song_title: str
    genre: str          # Human-readable genre label e.g. "Flamenco"
    is_random: bool = False  # True when genre was picked randomly
    tags: str
    lyrics: str
    bpm: int
    key_scale: str
    duration: int
    audio_url: str  # Proxied URL: /api/audio/{id}
    dj_name: str = ""            # DJ who generated this track (empty if no DJ session)
    dj_keywords: list[str] = []  # Keywords chosen by the DJ for this track
    dj_language: str = ""        # Language chosen by the DJ for this track
    replay: bool = False         # True when served from the persistent library while generating


class RadioStartRequest(BaseModel):
    genres: list[str]
    keywords: list[str] = []
    language: str = "en"      # ISO 639-1 code, or "instrumental" for no-vocal tracks
    feeling: str = ""         # Free-text mood description from user (max ~200 chars)


class WSMessage(BaseModel):
    event: str  # "track_ready" | "status" | "error"
    data: dict


class ReactionAction(str, Enum):
    THUMB_UP = "thumb_up"
    THUMB_DOWN = "thumb_down"


class ReactRequest(BaseModel):
    action: ReactionAction
