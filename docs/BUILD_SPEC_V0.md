# Generative Radio — AI-Generated Radio Web App: Full Build Specification

> **Purpose:** This document contains everything needed to build the "Generative Radio" web app from scratch on a Mac mini (Apple Silicon, 64GB RAM). It is designed to be self-contained — a single reference for an AI coding assistant to implement the entire project without needing to research external APIs.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Tech Stack & Versions](#3-tech-stack--versions)
4. [Project Structure](#4-project-structure)
5. [Prerequisites & Setup](#5-prerequisites--setup)
6. [ACE-Step 1.5 REST API Reference](#6-ace-step-15-rest-api-reference)
7. [Ollama LLM Integration Reference](#7-ollama-llm-integration-reference)
8. [Backend Implementation Spec](#8-backend-implementation-spec)
9. [Frontend Implementation Spec](#9-frontend-implementation-spec)
10. [WebSocket Protocol](#10-websocket-protocol)
11. [Launch Scripts](#11-launch-scripts)
12. [macOS-Specific Configuration](#12-macos-specific-configuration)
13. [Build Order & Task Checklist](#13-build-order--task-checklist)

---

## 1. Project Overview

**Generative Radio** is a fully local AI-generated radio web app. The user selects music genres and mood keywords, and the app continuously generates and plays original songs — like an endless AI radio station.

**Core loop:**
1. User picks genres (e.g., "Indie Rock") and keywords (e.g., "Dreamy", "Melancholic")
2. A local LLM (Ollama) acts as a "DJ brain" — generates creative song prompts with tags, lyrics, BPM, key
3. The prompt is sent to ACE-Step 1.5 (local music generation model) which produces a full song
4. The song plays in the browser
5. While it plays, the next song is pre-generated in the background
6. When the song ends, the next one plays immediately — seamless radio experience
7. User can Stop, Play, or Skip at any time

**Everything runs locally.** No cloud APIs, no subscriptions, no internet required after setup.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────┐
│  Web Browser (React + Vite, TypeScript)         │
│                                                 │
│  ┌──────────────┐  ┌────────────────────────┐   │
│  │ Genre/Keyword │  │ Radio Player           │   │
│  │ Selector     │  │  - <audio> element      │   │
│  │              │  │  - Play / Stop / Skip   │   │
│  └──────┬───────┘  │  - Now Playing display  │   │
│         │          │  - Status bar           │   │
│         │          └──────────┬──────────────┘   │
└─────────┼─────────────────────┼──────────────────┘
          │ REST                │ WebSocket
          │ POST /api/radio/*   │ ws://localhost:5555/ws
          │                     │
┌─────────▼─────────────────────▼──────────────────┐
│  Python Backend (FastAPI) — port 5555            │
│                                                  │
│  ┌─────────────────────────────────────────┐     │
│  │ Radio Orchestrator (async background)   │     │
│  │  - Manages radio session state          │     │
│  │  - Pre-buffer: generates next song      │     │
│  │    while current one plays              │     │
│  │  - Tracks session history for variety   │     │
│  └────────┬────────────────────┬───────────┘     │
│           │                    │                  │
│  ┌────────▼──────┐   ┌────────▼──────────┐       │
│  │ Ollama Client │   │ ACE-Step Client   │       │
│  │ (llm.py)     │   │ (acestep_client)  │       │
│  └────────┬──────┘   └────────┬──────────┘       │
└───────────┼────────────────────┼─────────────────┘
            │                    │
   ┌────────▼──────┐   ┌────────▼──────────────┐
   │ Ollama Server │   │ ACE-Step 1.5 API     │
   │ port 11434   │   │ port 8001            │
   │ Model:       │   │ MLX backend (macOS)  │
   │ qwen3:8b or  │   │ Turbo model, 8 steps │
   │ qwen3:14b*   │   │                      │
   └───────────────┘   └──────────────────────┘
   * auto-selected by config.py based on unified memory
```

### Data Flow (Radio Loop)

```
[User clicks PLAY with "Jazz" + "Chill" selected]
        │
        ▼
[FastAPI receives POST /api/radio/start]
        │
        ▼
[Radio Orchestrator starts async loop]
        │
        ▼
[Ollama LLM generates structured prompt]
  Input:  genres=["Jazz"], keywords=["Chill"], history=[...]
  Output: {tags: "smooth jazz, mellow saxophone, soft piano, chill vibes",
           lyrics: "[verse]\nMoonlight falls on city streets...",
           bpm: 85, key_scale: "Bb Major", duration: 90,
           song_title: "Midnight Boulevard"}
        │
        ▼
[ACE-Step API: POST /release_task]
  Input:  {prompt: "smooth jazz, mellow saxophone...",
           lyrics: "[verse]\nMoonlight falls...",
           bpm: 85, key_scale: "Bb Major",
           audio_duration: 90, thinking: true,
           batch_size: 1, audio_format: "mp3"}
  Output: {task_id: "abc-123"}
        │
        ▼
[Poll: POST /query_result every 2s until status=1]
  Output: {status: 1, result: [{file: "/v1/audio?path=..."}]}
        │
        ▼
[WebSocket → Browser: track_ready event with track metadata + audio URL]
        │
        ▼
[Browser plays audio via <audio> element]
[Simultaneously: Orchestrator starts generating NEXT song]
        │
        ▼
[Browser fires "track_ended" via WebSocket]
        │
        ▼
[Next pre-generated track plays immediately]
[Cycle repeats...]
```

---

## 3. Tech Stack & Versions

| Component | Technology | Version / Notes |
|---|---|---|
| **Frontend** | React + Vite + TypeScript | React 19, Vite 6+, TS 5+ |
| **Backend** | Python FastAPI | Python 3.11-3.12, FastAPI 0.115+ |
| **LLM** | Ollama + qwen3:8b / qwen3:14b | Ollama latest; 8b (~5.2GB) on ≤24GB machines, 14b (~9.3GB) on 32GB+ machines; auto-selected at runtime |
| **Music Gen** | ACE-Step 1.5 | GitHub repo, `acestep-api` command |
| **Package Mgmt** | uv (Python), npm (JS) | uv for ACE-Step & backend |
| **Audio Format** | MP3 (default) | Also supports WAV, FLAC |

### Python Dependencies (backend/requirements.txt)

```
fastapi>=0.115.0
uvicorn[standard]>=0.32.0
ollama>=0.5.1
httpx>=0.27.0
pydantic>=2.0.0
```

### Node Dependencies (frontend/package.json)

```json
{
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
```

---

## 4. Project Structure

```
radio/
├── backend/
│   ├── main.py                # FastAPI app: REST endpoints, WebSocket, CORS, startup
│   ├── radio.py               # RadioOrchestrator: async loop, pre-buffering, state machine
│   ├── llm.py                 # OllamaClient: prompt generation with structured output
│   ├── acestep_client.py      # ACEStepClient: task submission, polling, audio retrieval
│   ├── models.py              # Pydantic models for API requests/responses & LLM output
│   ├── genres.py              # Genre and keyword definitions (static data)
│   ├── config.py              # Runtime config: Apple Silicon memory detection, model auto-selection
│   └── requirements.txt       # Python dependencies
├── frontend/
│   ├── index.html             # HTML entry point
│   ├── package.json           # Node dependencies
│   ├── tsconfig.json          # TypeScript config
│   ├── vite.config.ts         # Vite config (proxy to backend)
│   └── src/
│       ├── main.tsx           # React entry point
│       ├── App.tsx            # Main layout: GenreSelector → RadioPlayer
│       ├── App.css            # Global styles (dark theme, radio aesthetic)
│       ├── types.ts           # Shared TypeScript types
│       ├── components/
│       │   ├── GenreSelector.tsx   # Genre grid + keyword mood chips
│       │   ├── RadioPlayer.tsx     # Audio player, Play/Stop/Skip, Now Playing
│       │   └── StatusBar.tsx       # Generation progress / status indicator
│       └── hooks/
│           └── useRadio.ts        # WebSocket hook, radio state machine
├── scripts/
│   ├── setup.sh               # One-time: install Ollama, pull model, clone ACE-Step
│   └── start.sh               # Launch all 3 services (Ollama, ACE-Step API, FastAPI backend)
├── BUILD_SPEC.md              # This file
├── research-local-ai-music-generation-mac.md  # Background research
└── README.md                  # User-facing setup & usage instructions
```

---

## 5. Prerequisites & Setup

### Hardware

- Mac mini with Apple Silicon (M1/M2/M3/M4)
- 64GB unified memory
- 50GB+ free SSD space (for models)

### Software Prerequisites

```bash
# 1. Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. Core tools
brew install python@3.11 node git git-lfs ffmpeg

# 3. uv (Python package manager — used by ACE-Step)
curl -LsSf https://astral.sh/uv/install.sh | sh

# 4. Ollama (local LLM server)
brew install ollama

# 5. Pull the LLM models
# qwen3:8b  (~5.2GB) — used automatically on machines with <32GB unified memory (e.g. dev machine)
# qwen3:14b (~9.3GB) — used automatically on machines with 32GB+ unified memory (e.g. Mac Mini)
ollama pull qwen3:8b
ollama pull qwen3:14b

# 6. Clone ACE-Step 1.5 (as a sibling directory or wherever you prefer)
cd /path/to/projects
git clone https://github.com/ACE-Step/ACE-Step-1.5.git
cd ACE-Step-1.5
uv sync
# First run will download model weights (~several GB, takes ~40 min)

# 7. Enable git-lfs
git lfs install
```

### Environment Variables for macOS

Add to `~/.zshrc`:

```bash
# Allow PyTorch MPS to use all available unified memory
export PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0

# Fall back to CPU for unsupported MPS operations
export PYTORCH_ENABLE_MPS_FALLBACK=1
```

---

## 6. ACE-Step 1.5 REST API Reference

ACE-Step 1.5 provides an async HTTP API via `acestep-api` (default port 8001).

### Starting the API Server (macOS)

```bash
cd /path/to/ACE-Step-1.5

# Option A: Use the macOS-specific launch script (recommended)
chmod +x start_api_server_macos.sh
./start_api_server_macos.sh

# Option B: Direct command
ACESTEP_LM_BACKEND=mlx TOKENIZERS_PARALLELISM=false uv run acestep-api --host 127.0.0.1 --port 8001
```

The macOS script sets `ACESTEP_LM_BACKEND=mlx` for native Apple Silicon acceleration.

### API Endpoints

#### POST /release_task — Submit a Generation Task

Creates an async music generation job. Returns a `task_id` for polling.

**Request (JSON):**

```json
{
  "prompt": "smooth jazz, mellow saxophone, soft piano, chill vibes, nightclub atmosphere",
  "lyrics": "[verse]\nMoonlight falls on city streets\nSoft piano plays a gentle beat\nSaxophone whispers through the air\nMelodies floating everywhere\n\n[chorus]\nLet the music take you there\nClose your eyes without a care",
  "thinking": true,
  "audio_duration": 90,
  "bpm": 85,
  "key_scale": "Bb Major",
  "time_signature": "4",
  "batch_size": 1,
  "audio_format": "mp3",
  "inference_steps": 8,
  "use_random_seed": true
}
```

**Key parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `prompt` | string | `""` | Music description / style tags (alias: `caption`) |
| `lyrics` | string | `""` | Song lyrics with structure tags `[verse]`, `[chorus]`, `[bridge]` |
| `thinking` | bool | `false` | **Set to `true`** — uses 5Hz LM for enhanced quality (LM-DiT mode) |
| `audio_duration` | float | null | Duration in seconds, range 10-600 |
| `bpm` | int | null | Tempo, range 30-300 |
| `key_scale` | string | `""` | e.g., "C Major", "Am", "Bb Major" |
| `time_signature` | string | `""` | "2", "3", "4", or "6" (for 2/4, 3/4, 4/4, 6/8) |
| `batch_size` | int | `2` | Number of variations to generate (use `1` for radio) |
| `audio_format` | string | `"mp3"` | Output format: "mp3", "wav", "flac" |
| `inference_steps` | int | `8` | Steps for turbo model (1-20, recommended 8) |
| `use_random_seed` | bool | `true` | Randomize seed each generation |
| `use_format` | bool | `false` | Let ACE-Step's LM enhance the prompt |
| `use_cot_caption` | bool | `true` | Let LM rewrite/enhance caption via CoT |
| `sample_query` | string | `""` | Natural language description (auto-generates everything) |
| `model` | string | null | DiT model name (e.g., "acestep-v15-turbo") |

**Response:**

```json
{
  "data": {
    "task_id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "queued",
    "queue_position": 1
  },
  "code": 200,
  "error": null,
  "timestamp": 1700000000000,
  "extra": null
}
```

#### POST /query_result — Poll Task Status

**Request:**

```json
{
  "task_id_list": ["550e8400-e29b-41d4-a716-446655440000"]
}
```

**Response (task in progress):**

```json
{
  "data": [
    {
      "task_id": "550e8400-e29b-41d4-a716-446655440000",
      "status": 0,
      "result": null
    }
  ],
  "code": 200,
  "error": null
}
```

**Response (task completed — status=1):**

```json
{
  "data": [
    {
      "task_id": "550e8400-e29b-41d4-a716-446655440000",
      "status": 1,
      "result": "[{\"file\": \"/v1/audio?path=%2Ftmp%2Fapi_audio%2Fabc123.mp3\", \"status\": 1, \"prompt\": \"smooth jazz...\", \"lyrics\": \"...\", \"metas\": {\"bpm\": 85, \"duration\": 90, \"keyscale\": \"Bb Major\", \"timesignature\": \"4\"}, \"seed_value\": \"12345\"}]"
    }
  ],
  "code": 200,
  "error": null
}
```

**IMPORTANT:** The `result` field is a **JSON string** that must be parsed again. After parsing, it's an array of result objects. Each has a `file` field with the audio download URL.

**Status codes:** `0` = queued/running, `1` = succeeded, `2` = failed.

#### GET /v1/audio?path=... — Download Audio

Download the generated audio file. The `path` parameter is URL-encoded.

```
GET http://localhost:8001/v1/audio?path=%2Ftmp%2Fapi_audio%2Fabc123.mp3
```

Returns the audio file with appropriate Content-Type.

#### GET /health — Health Check

```json
{"data": {"status": "ok", "service": "ACE-Step API", "version": "1.0"}, "code": 200}
```

#### GET /v1/models — List Available Models

```json
{
  "data": {
    "models": [
      {"name": "acestep-v15-turbo", "is_default": true}
    ],
    "default_model": "acestep-v15-turbo"
  },
  "code": 200
}
```

#### GET /v1/stats — Server Statistics

```json
{
  "data": {
    "jobs": {"total": 10, "queued": 0, "running": 1, "succeeded": 9, "failed": 0},
    "avg_job_seconds": 15.2
  },
  "code": 200
}
```

### ACE-Step Performance on Apple Silicon

From official benchmarks (MacBook M2 Max):

| Steps | Time to render 1 min audio | Real-Time Factor |
|---|---|---|
| 27 steps | 26.4s | 2.27x |
| 60 steps | 58.3s | 1.03x |
| 8 steps (turbo) | ~8-12s (estimated) | ~5-7x (estimated) |

With 64GB Mac mini, expect similar or better. A 90-second song at turbo (8 steps) should take roughly **12-20 seconds** to generate.

---

## 7. Ollama LLM Integration Reference

### Ollama Server

Ollama runs as a background service on port 11434. Start it with:

```bash
ollama serve
# Or it auto-starts when you run ollama commands
```

### Model Selection Strategy

Two Qwen3 models are used, selected automatically at runtime based on the machine's unified memory:

| Model | Ollama Size | Context | Quality | Auto-selected when |
|---|---|---|---|---|
| `qwen3:8b` | ~5.2 GB | 40K tokens | ≈ Qwen2.5-14B | Unified memory **< 32 GB** (e.g. 24GB dev machine) |
| `qwen3:14b` | ~9.3 GB | 40K tokens | Rich & creative | Unified memory **≥ 32 GB** (e.g. 64GB Mac Mini) |

Qwen3 is a generational improvement over Qwen2.5: `qwen3:8b` matches the quality of the old `qwen2.5:14b`. Both models support structured JSON output via the Ollama SDK.

**Thinking mode is disabled** (`think=False`). Qwen3's chain-of-thought reasoning mode adds latency without improving the structured JSON output quality needed for song prompt generation.

### Apple Silicon Memory Detection (`config.py`)

The model is selected once at process startup using macOS's `sysctl` interface:

```python
import subprocess

# Memory thresholds for model selection (unified memory in GB)
MODEL_SMALL = "qwen3:8b"   # < 32 GB unified memory
MODEL_LARGE = "qwen3:14b"  # ≥ 32 GB unified memory
MEMORY_THRESHOLD_GB = 32

def get_unified_memory_gb() -> int:
    """Read total unified memory via sysctl (Apple Silicon / macOS only)."""
    result = subprocess.run(
        ["sysctl", "-n", "hw.memsize"],
        capture_output=True, text=True, check=True,
    )
    return int(result.stdout.strip()) // (1024 ** 3)

def select_ollama_model() -> str:
    """Return the appropriate Qwen3 model tag for this machine."""
    memory_gb = get_unified_memory_gb()
    model = MODEL_LARGE if memory_gb >= MEMORY_THRESHOLD_GB else MODEL_SMALL
    print(f"[config] Detected {memory_gb}GB unified memory → using {model}")
    return model

# Module-level singleton — resolved once at import time
OLLAMA_MODEL: str = select_ollama_model()
```

`OLLAMA_MODEL` is imported by `llm.py` and used as the default. It can also be overridden via the `OLLAMA_MODEL` environment variable for manual control during development:

```bash
OLLAMA_MODEL=qwen3:14b uvicorn main:app ...
```

### Python SDK — Structured Output with Pydantic

The `ollama` Python package supports structured output by passing a Pydantic model's JSON schema as the `format` parameter. This constrains the LLM to output valid JSON matching the schema.

**Installation:**

```bash
pip install ollama
```

**Usage pattern for our project:**

```python
import os
from ollama import chat
from pydantic import BaseModel, Field
from config import OLLAMA_MODEL

class SongPrompt(BaseModel):
    """Structured output from the LLM DJ brain."""
    song_title: str = Field(description="Creative title for the song")
    tags: str = Field(description="Comma-separated music style tags for ACE-Step")
    lyrics: str = Field(description="Song lyrics with [verse], [chorus], [bridge] markers")
    bpm: int = Field(description="Tempo in BPM", ge=60, le=200)
    key_scale: str = Field(description="Musical key, e.g. 'C Major', 'Am', 'F# Minor'")
    duration: int = Field(description="Song duration in seconds", ge=30, le=180)

def generate_song_prompt(
    genres: list[str],
    keywords: list[str],
    history: list[str],  # list of previous song_titles to avoid repetition
    model: str | None = None,
) -> SongPrompt:
    # Allow env override; fall back to auto-detected model
    model = model or os.environ.get("OLLAMA_MODEL", OLLAMA_MODEL)

    history_text = ""
    if history:
        history_text = (
            "\n\nSongs already played this session (do NOT repeat similar themes/styles):\n"
            + "\n".join(f"- {h}" for h in history[-10:])
        )

    system_prompt = f"""You are a creative AI radio DJ. Your job is to generate unique, 
original song prompts for an AI music generator.

SELECTED GENRES: {', '.join(genres)}
SELECTED MOODS/KEYWORDS: {', '.join(keywords) if keywords else 'None specified'}
{history_text}

RULES:
- Write original lyrics (2-4 sections using [verse], [chorus], [bridge] markers)
- The "tags" field should be a comma-separated list of musical style descriptors 
  that ACE-Step understands: genre, instruments, mood, tempo feel, vocal style, etc.
- Vary the sub-genre, tempo, key, mood, and lyric themes between songs
- Lyrics should be creative and evocative, not generic
- Keep lyrics concise (4-8 lines per section)
- BPM should match the genre and mood naturally
- Duration should be between 60-120 seconds"""

    response = chat(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": "Generate the next song for the radio station."},
        ],
        format=SongPrompt.model_json_schema(),
        think=False,  # Disable Qwen3 chain-of-thought; not needed for structured JSON output
    )

    return SongPrompt.model_validate_json(response.message.content)
```

**Important Ollama notes:**

- The `format` parameter accepts a JSON Schema dict (from Pydantic's `model_json_schema()`)
- The response `message.content` is a JSON string — parse with `model_validate_json()`
- `think=False` requires `ollama>=0.5.1` — this is specified in `requirements.txt`
- Ollama automatically uses Metal/GPU on Apple Silicon
- Response time: typically 2–4 seconds on 24GB Apple Silicon (8b), 3–6 seconds on 64GB (14b)

---

## 8. Backend Implementation Spec

### models.py — Pydantic Models

```python
from pydantic import BaseModel, Field
from enum import Enum

# --- Radio State ---
class RadioState(str, Enum):
    IDLE = "idle"           # No session active
    GENERATING = "generating"  # Generating a song (no song playing yet)
    PLAYING = "playing"     # Song is playing, may be pre-generating next
    BUFFERING = "buffering" # Current song done, next still generating
    STOPPED = "stopped"     # User stopped the radio

# --- LLM Output ---
class SongPrompt(BaseModel):
    song_title: str = Field(description="Creative title for the song")
    tags: str = Field(description="Comma-separated music style tags")
    lyrics: str = Field(description="Lyrics with [verse], [chorus], [bridge] markers")
    bpm: int = Field(ge=60, le=200)
    key_scale: str
    duration: int = Field(ge=30, le=180)

# --- Track Info (sent to frontend) ---
class TrackInfo(BaseModel):
    id: str                  # Unique track ID (uuid)
    song_title: str
    tags: str
    lyrics: str
    bpm: int
    key_scale: str
    duration: int
    audio_url: str           # Proxied URL: /api/audio/{track_id}

# --- API Requests ---
class RadioStartRequest(BaseModel):
    genres: list[str]
    keywords: list[str] = []

# --- WebSocket Messages (server → client) ---
class WSMessage(BaseModel):
    event: str               # "track_ready", "status", "error"
    data: dict
```

### genres.py — Genre and Keyword Definitions

```python
GENRES = [
    {"id": "rock", "label": "Rock", "icon": "🎸", "subgenres": ["indie rock", "alternative rock", "classic rock", "punk rock", "post-rock"]},
    {"id": "pop", "label": "Pop", "icon": "🎤", "subgenres": ["synth pop", "indie pop", "electropop", "dream pop", "art pop"]},
    {"id": "jazz", "label": "Jazz", "icon": "🎷", "subgenres": ["smooth jazz", "bebop", "cool jazz", "jazz fusion", "bossa nova"]},
    {"id": "electronic", "label": "Electronic", "icon": "🎹", "subgenres": ["ambient electronic", "house", "techno", "drum and bass", "synthwave"]},
    {"id": "hiphop", "label": "Hip-Hop", "icon": "🎙️", "subgenres": ["boom bap", "trap", "lo-fi hip hop", "conscious hip hop", "jazz rap"]},
    {"id": "classical", "label": "Classical", "icon": "🎻", "subgenres": ["orchestral", "chamber music", "piano solo", "romantic era", "minimalist"]},
    {"id": "lofi", "label": "Lo-Fi", "icon": "📻", "subgenres": ["lo-fi hip hop", "lo-fi chill", "lo-fi jazz", "lo-fi ambient", "chillhop"]},
    {"id": "ambient", "label": "Ambient", "icon": "🌊", "subgenres": ["dark ambient", "space ambient", "nature ambient", "drone", "new age"]},
    {"id": "rnb", "label": "R&B", "icon": "💜", "subgenres": ["neo soul", "contemporary R&B", "funk", "quiet storm", "alternative R&B"]},
    {"id": "folk", "label": "Folk", "icon": "🪕", "subgenres": ["indie folk", "acoustic folk", "folk rock", "Americana", "chamber folk"]},
    {"id": "metal", "label": "Metal", "icon": "🤘", "subgenres": ["progressive metal", "doom metal", "symphonic metal", "post-metal", "melodic death metal"]},
    {"id": "country", "label": "Country", "icon": "🤠", "subgenres": ["alt-country", "country pop", "bluegrass", "outlaw country", "country rock"]},
]

KEYWORDS = [
    {"id": "energetic", "label": "Energetic"},
    {"id": "melancholic", "label": "Melancholic"},
    {"id": "dreamy", "label": "Dreamy"},
    {"id": "aggressive", "label": "Aggressive"},
    {"id": "chill", "label": "Chill"},
    {"id": "upbeat", "label": "Upbeat"},
    {"id": "dark", "label": "Dark"},
    {"id": "romantic", "label": "Romantic"},
    {"id": "ethereal", "label": "Ethereal"},
    {"id": "groovy", "label": "Groovy"},
    {"id": "epic", "label": "Epic"},
    {"id": "nostalgic", "label": "Nostalgic"},
    {"id": "minimal", "label": "Minimal"},
    {"id": "psychedelic", "label": "Psychedelic"},
    {"id": "cinematic", "label": "Cinematic"},
]
```

### config.py — Runtime Configuration & Model Auto-Selection

Runs once at import time. Reads unified memory via `sysctl hw.memsize` (macOS/Apple Silicon only) and selects the appropriate Qwen3 model. Exposes a single constant:

```python
OLLAMA_MODEL: str  # "qwen3:8b" or "qwen3:14b", overridable via OLLAMA_MODEL env var
```

Selection logic:
- Unified memory **< 32 GB** → `qwen3:8b` (5.2 GB, ~35 tok/s — for dev machines)
- Unified memory **≥ 32 GB** → `qwen3:14b` (9.3 GB, ~25 tok/s — for Mac Mini production)

Environment variable override (useful during development):
```bash
OLLAMA_MODEL=qwen3:14b uvicorn main:app --port 5555
```

### llm.py — Ollama LLM Client

Wraps Ollama SDK. Uses structured output to generate `SongPrompt` objects. Imports `OLLAMA_MODEL` from `config.py` as the default model. Includes a system prompt that instructs the LLM to act as a creative DJ. Accepts genre, keywords, and session history (last 10 song titles) to ensure variety.

Key method: `async def generate_prompt(genres, keywords, history) -> SongPrompt`

Use `ollama.chat()` (synchronous) wrapped in `asyncio.to_thread()` to avoid blocking the event loop.

Always pass `think=False` to the `chat()` call — Qwen3's thinking mode is not needed for structured JSON prompt generation and adds unnecessary latency.

### acestep_client.py — ACE-Step REST API Client

Uses `httpx.AsyncClient` to communicate with ACE-Step API at `http://localhost:8001`.

Key methods:

```python
class ACEStepClient:
    def __init__(self, base_url: str = "http://localhost:8001"):
        self.base_url = base_url
        self.client = httpx.AsyncClient(base_url=base_url, timeout=300.0)

    async def health_check(self) -> bool:
        """GET /health — check if ACE-Step is running."""

    async def submit_task(self, prompt: SongPrompt) -> str:
        """POST /release_task — submit generation task, return task_id.
        
        Maps SongPrompt fields to ACE-Step API params:
          prompt.tags     → "prompt" field
          prompt.lyrics   → "lyrics" field
          prompt.bpm      → "bpm" field
          prompt.key_scale → "key_scale" field
          prompt.duration → "audio_duration" field
        
        Always set: thinking=true, batch_size=1, audio_format="mp3", inference_steps=8
        """

    async def poll_task(self, task_id: str, interval: float = 2.0) -> dict:
        """POST /query_result — poll until status=1 or status=2.
        
        Returns parsed result dict with 'file' key containing audio path.
        IMPORTANT: The 'result' field in the response is a JSON STRING that must
        be parsed again with json.loads(). After parsing, it's a list of dicts.
        """

    async def get_audio_bytes(self, audio_path: str) -> bytes:
        """GET /v1/audio?path=... — download the generated audio file as bytes."""

    async def generate_song(self, prompt: SongPrompt) -> tuple[bytes, dict]:
        """Full pipeline: submit → poll → download. Returns (audio_bytes, metadata)."""
```

### radio.py — Radio Orchestrator

The core state machine that manages the radio session.

```python
class RadioOrchestrator:
    def __init__(self, llm: OllamaClient, acestep: ACEStepClient):
        self.llm = llm
        self.acestep = acestep
        self.state: RadioState = RadioState.IDLE
        self.genres: list[str] = []
        self.keywords: list[str] = []
        self.history: list[str] = []         # Song titles for variety
        self.current_track: TrackInfo | None = None
        self.next_track: TrackInfo | None = None  # Pre-buffered
        self.audio_cache: dict[str, bytes] = {}   # track_id → audio bytes
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()
        self._track_ended_event = asyncio.Event()
        self._ws_connections: list[WebSocket] = []

    async def start(self, genres: list[str], keywords: list[str]):
        """Start the radio loop as a background task."""

    async def stop(self):
        """Stop the radio loop, cancel background generation."""

    async def skip(self):
        """Skip current track — signal track_ended immediately."""

    async def on_track_ended(self):
        """Called when frontend reports track finished playing."""

    async def _radio_loop(self):
        """Main loop:
        1. Generate first track (LLM → ACE-Step)
        2. Broadcast track_ready to all WebSocket clients
        3. Start pre-generating next track
        4. Wait for track_ended signal
        5. Swap next_track → current_track
        6. Broadcast new track_ready
        7. Start pre-generating another next track
        8. Repeat until stopped
        """

    async def _generate_track(self) -> TrackInfo:
        """Generate a single track:
        1. Call LLM to get SongPrompt
        2. Call ACE-Step to generate audio
        3. Cache audio bytes in self.audio_cache
        4. Return TrackInfo with proxied audio URL
        """

    async def broadcast(self, message: WSMessage):
        """Send message to all connected WebSocket clients."""
```

### main.py — FastAPI Application

```python
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

app = FastAPI(title="Generative Radio")

# CORS for frontend dev server (Vite on port 5173)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Endpoints:

# GET  /api/genres          → Return GENRES and KEYWORDS lists
# POST /api/radio/start     → Start radio with {genres, keywords}
# POST /api/radio/stop      → Stop the radio
# POST /api/radio/skip      → Skip to next track
# GET  /api/radio/status    → Current state, current_track info
# GET  /api/audio/{track_id} → Serve cached audio bytes (proxied from ACE-Step)
# WS   /ws                  → WebSocket for real-time events
```

**WebSocket handler:**

```python
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    radio.add_ws(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            if data.get("event") == "track_ended":
                await radio.on_track_ended()
    except WebSocketDisconnect:
        radio.remove_ws(websocket)
```

**Audio proxy endpoint:**

```python
@app.get("/api/audio/{track_id}")
async def get_audio(track_id: str):
    audio_bytes = radio.audio_cache.get(track_id)
    if not audio_bytes:
        raise HTTPException(404, "Track not found")
    return Response(content=audio_bytes, media_type="audio/mpeg")
```

---

## 9. Frontend Implementation Spec

### Design & Aesthetics

- **Theme:** Dark background (#0a0a0f or similar deep navy/black), with accent colors (warm amber/orange for active states, cool blue/purple for secondary)
- **Aesthetic:** Minimal, modern radio interface. Think: a premium internet radio player
- **Typography:** Clean sans-serif (system fonts or Inter)
- **Layout:** Centered single-column, mobile-friendly, max-width ~600px

### App.tsx — Main Layout

Three states:
1. **Selection mode** (IDLE): Show GenreSelector, "Start Radio" button
2. **Playing mode** (GENERATING/PLAYING/BUFFERING): Show RadioPlayer + StatusBar, "Back" to change genres
3. Smooth transition between modes

### GenreSelector.tsx

- Grid of genre cards (3 columns on desktop, 2 on mobile)
- Each card shows icon + label, toggleable (highlighted when selected)
- Below genres: horizontal scrollable row of keyword chips, also toggleable
- "Start Radio" button at bottom (enabled when 1+ genre selected)
- Visually clear which genres/keywords are selected (border glow, color change)

### RadioPlayer.tsx

- **Now Playing section:**
  - Song title (large text)
  - Tags/genre (smaller, muted text)
  - Animated equalizer bars (CSS-only, 4-5 bars with varying animation speeds)
- **Controls:**
  - Large circular Play/Stop toggle button (center)
  - Skip button (to the right)
- **Progress:** Simple thin progress bar showing playback position
- **Audio element:** Hidden `<audio>` element controlled by the `useRadio` hook

### StatusBar.tsx

- Shows real-time generation status:
  - "Generating your first track..." (with spinner)
  - "Playing — next track ready" (green dot)
  - "Playing — generating next track..." (amber dot + spinner)
  - "Buffering next track..." (when current ended but next isn't ready)

### useRadio.ts — WebSocket Hook

```typescript
type RadioStatus = "idle" | "connecting" | "generating" | "playing" | "buffering" | "stopped";

interface Track {
  id: string;
  songTitle: string;
  tags: string;
  lyrics: string;
  bpm: number;
  keyScale: string;
  duration: number;
  audioUrl: string;
}

interface UseRadioReturn {
  status: RadioStatus;
  currentTrack: Track | null;
  nextReady: boolean;
  start: (genres: string[], keywords: string[]) => Promise<void>;
  stop: () => Promise<void>;
  skip: () => void;
  audioRef: React.RefObject<HTMLAudioElement>;
}
```

**WebSocket message handling:**

```typescript
// Server → Client messages:
// { event: "track_ready", data: { track: Track, isNext: boolean } }
//   - If isNext=false: this is the current track, start playing immediately
//   - If isNext=true: this is pre-buffered, store for when current ends
//
// { event: "status", data: { state: RadioState, message: string } }
//   - UI status updates
//
// { event: "error", data: { message: string } }
//   - Error display

// Client → Server messages:
// { event: "track_ended" }
//   - Sent when <audio> element fires "ended" event
```

**Audio playback logic:**

```typescript
// When track_ready (isNext=false) received:
//   1. Set audioRef.src = track.audioUrl
//   2. audioRef.play()
//   3. Update currentTrack state
//
// When <audio> "ended" event fires:
//   1. Send { event: "track_ended" } via WebSocket
//   2. If nextTrack is available, immediately play it
//   3. Set status to "buffering" if next not ready
//
// When track_ready (isNext=true) received:
//   1. Store as nextTrack
//   2. Update nextReady = true
```

### vite.config.ts

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:5555',
      '/ws': {
        target: 'ws://localhost:5555',
        ws: true,
      },
    },
  },
})
```

---

## 10. WebSocket Protocol

### Connection

```
ws://localhost:5555/ws
```

Frontend connects on mount, reconnects on disconnect (with exponential backoff).

### Server → Client Messages

#### track_ready

Sent when a song has been generated and is ready to play.

```json
{
  "event": "track_ready",
  "data": {
    "track": {
      "id": "a1b2c3d4",
      "songTitle": "Midnight Boulevard",
      "tags": "smooth jazz, mellow saxophone, soft piano",
      "lyrics": "[verse]\nMoonlight falls on city streets...",
      "bpm": 85,
      "keyScale": "Bb Major",
      "duration": 90,
      "audioUrl": "/api/audio/a1b2c3d4"
    },
    "isNext": false
  }
}
```

- `isNext: false` → Play this track immediately (it's the current track)
- `isNext: true` → Buffer this track (it's pre-generated for seamless transition)

#### status

Sent to update the UI status bar.

```json
{
  "event": "status",
  "data": {
    "state": "playing",
    "message": "Generating next track...",
    "nextReady": false
  }
}
```

#### error

```json
{
  "event": "error",
  "data": {
    "message": "ACE-Step server is not responding. Please check if it's running."
  }
}
```

### Client → Server Messages

#### track_ended

Sent when the `<audio>` element fires its `ended` event.

```json
{
  "event": "track_ended"
}
```

---

## 11. Launch Scripts

### scripts/setup.sh

One-time setup script. Checks and installs prerequisites.

```bash
#!/bin/bash
set -e

echo "=== Generative Radio Setup ==="

# Check Homebrew
if ! command -v brew &>/dev/null; then
  echo "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# Install system deps
brew install python@3.11 node ffmpeg git-lfs || true

# Install uv
if ! command -v uv &>/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

# Install Ollama
if ! command -v ollama &>/dev/null; then
  brew install ollama
fi

# Pull LLM models (both are pulled so the correct one is available on any machine)
# config.py selects automatically at runtime based on unified memory:
#   qwen3:8b  — used on machines with <32GB unified memory (e.g. 24GB dev machine)
#   qwen3:14b — used on machines with 32GB+ unified memory (e.g. 64GB Mac Mini)
echo "Pulling qwen3:8b (~5.2GB)..."
ollama pull qwen3:8b
echo "Pulling qwen3:14b (~9.3GB)..."
ollama pull qwen3:14b

# Clone ACE-Step 1.5 if not present
ACESTEP_DIR="${ACESTEP_PATH:-../ACE-Step-1.5}"
if [ ! -d "$ACESTEP_DIR" ]; then
  echo "Cloning ACE-Step 1.5..."
  git clone https://github.com/ACE-Step/ACE-Step-1.5.git "$ACESTEP_DIR"
  cd "$ACESTEP_DIR" && uv sync && cd -
else
  echo "ACE-Step 1.5 found at $ACESTEP_DIR"
fi

# Install backend deps
echo "Installing backend Python dependencies..."
cd backend && pip install -r requirements.txt && cd ..

# Install frontend deps
echo "Installing frontend Node dependencies..."
cd frontend && npm install && cd ..

echo ""
echo "=== Setup complete! ==="
echo "Run ./scripts/start.sh to launch the radio."
```

### scripts/start.sh

Launches all three services and the frontend dev server.

```bash
#!/bin/bash
set -e

ACESTEP_DIR="${ACESTEP_PATH:-../ACE-Step-1.5}"

echo "=== Starting Generative Radio ==="

# Set macOS env vars
export PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0
export PYTORCH_ENABLE_MPS_FALLBACK=1

# 1. Start Ollama (if not already running)
if ! pgrep -x "ollama" > /dev/null; then
  echo "[1/4] Starting Ollama..."
  ollama serve &
  sleep 2
else
  echo "[1/4] Ollama already running."
fi

# 2. Start ACE-Step API server
echo "[2/4] Starting ACE-Step 1.5 API server..."
cd "$ACESTEP_DIR"
ACESTEP_LM_BACKEND=mlx TOKENIZERS_PARALLELISM=false \
  uv run acestep-api --host 127.0.0.1 --port 8001 &
ACESTEP_PID=$!
cd - > /dev/null

# Wait for ACE-Step to be ready
echo "  Waiting for ACE-Step API to be ready..."
for i in {1..120}; do
  if curl -s http://localhost:8001/health > /dev/null 2>&1; then
    echo "  ACE-Step API ready!"
    break
  fi
  sleep 2
done

# 3. Start FastAPI backend
echo "[3/4] Starting backend server..."
cd backend
uvicorn main:app --host 127.0.0.1 --port 5555 --reload &
BACKEND_PID=$!
cd ..

# 4. Start frontend dev server
echo "[4/4] Starting frontend dev server..."
cd frontend
npm run dev &
FRONTEND_PID=$!
cd ..

echo ""
echo "=== Generative Radio is live! ==="
echo "  Frontend:   http://localhost:5173"
echo "  Backend:    http://localhost:5555"
echo "  ACE-Step:   http://localhost:8001"
echo "  Ollama:     http://localhost:11434"
echo ""
echo "Press Ctrl+C to stop all services."

# Trap Ctrl+C to clean up
trap "echo 'Shutting down...'; kill $ACESTEP_PID $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM

# Wait for all background processes
wait
```

---

## 12. macOS-Specific Configuration

### Environment Variables

```bash
# ~/.zshrc additions
export PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0   # Allow full memory usage for MPS
export PYTORCH_ENABLE_MPS_FALLBACK=1           # CPU fallback for unsupported ops
```

### ACE-Step macOS Settings

- Use `ACESTEP_LM_BACKEND=mlx` for Apple Silicon native LM inference
- The macOS launch script (`start_api_server_macos.sh`) handles this automatically
- `--bf16 false` flag may be needed on some macOS versions (the macOS script handles this)
- Turbo model (`acestep-v15-turbo`) with 8 inference steps is the recommended config

### Memory Considerations

Both target machines run all services comfortably. The correct Qwen3 model is selected automatically at runtime by `config.py`:

| Service | Dev Machine (24GB) | Mac Mini (64GB) | Notes |
|---|---|---|---|
| Ollama (`qwen3:8b`) | ~5.2 GB | — | Auto-selected when unified memory < 32 GB |
| Ollama (`qwen3:14b`) | — | ~9.3 GB | Auto-selected when unified memory ≥ 32 GB |
| ACE-Step 1.5 (turbo) | ~4–6 GB | ~4–6 GB | DiT model + VAE + LM; MLX backend |
| FastAPI backend | ~100 MB | ~100 MB | Lightweight, plus in-memory audio cache |
| Frontend (browser) | ~200 MB | ~200 MB | Standard React app |
| **Total** | **~10–12 GB** | **~14–16 GB** | Dev: ~12 GB free; Mac Mini: ~48 GB free |

### Port Summary

| Service | Port | Purpose |
|---|---|---|
| Frontend (Vite) | 5173 | Dev server with HMR |
| Backend (FastAPI) | 5555 | REST API + WebSocket |
| ACE-Step API | 8001 | Music generation |
| Ollama | 11434 | LLM inference |

---

## 13. Build Order & Task Checklist

Build in this order — each step builds on the previous:

### Phase 1: Foundation

- [ ] **1.1** Create project directory structure (all folders, empty files)
- [ ] **1.2** Write `backend/requirements.txt` with pinned deps
- [ ] **1.3** Write `backend/models.py` — all Pydantic models
- [ ] **1.4** Write `backend/genres.py` — genre/keyword static data

### Phase 2: Backend Services

- [ ] **2.1** Write `backend/acestep_client.py` — ACE-Step REST API client (submit, poll, download)
- [ ] **2.2** Write `backend/llm.py` — Ollama client with structured output
- [ ] **2.3** Write `backend/radio.py` — RadioOrchestrator async state machine
- [ ] **2.4** Write `backend/main.py` — FastAPI app with all endpoints + WebSocket

### Phase 3: Frontend

- [ ] **3.1** Scaffold React + Vite + TypeScript project (`npm create vite@latest`)
- [ ] **3.2** Configure `vite.config.ts` with backend proxy
- [ ] **3.3** Write `src/types.ts` — shared TypeScript types
- [ ] **3.4** Write `src/hooks/useRadio.ts` — WebSocket + radio state hook
- [ ] **3.5** Write `src/components/GenreSelector.tsx`
- [ ] **3.6** Write `src/components/RadioPlayer.tsx`
- [ ] **3.7** Write `src/components/StatusBar.tsx`
- [ ] **3.8** Write `src/App.tsx` + `src/App.css` — layout + dark theme styling
- [ ] **3.9** Write `src/main.tsx` — React entry point

### Phase 4: Scripts & Docs

- [ ] **4.1** Write `scripts/setup.sh`
- [ ] **4.2** Write `scripts/start.sh`
- [ ] **4.3** Write `README.md` — user-facing setup & usage

### Phase 5: Integration Test

- [ ] **5.1** Start all services using `start.sh`
- [ ] **5.2** Open browser, select a genre, click Play
- [ ] **5.3** Verify: LLM generates prompt → ACE-Step generates song → audio plays
- [ ] **5.4** Verify: next song pre-generates and plays seamlessly
- [ ] **5.5** Verify: Stop/Skip controls work correctly
