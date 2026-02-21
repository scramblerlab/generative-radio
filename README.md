# Generative Radio

A fully local, offline AI radio web app. Pick genres and moods — the app generates and plays an endless stream of original AI-composed songs with no cloud APIs required.

## Requirements

- Mac with Apple Silicon (M1/M2/M3/M4)
- macOS 14+
- 16GB+ unified memory (24GB+ recommended for development, 64GB for production)
- 50GB+ free SSD space

## Quick Start

### 1. One-time setup

```bash
./scripts/setup.sh
```

This installs Homebrew tools, Ollama, both LLM models, clones ACE-Step 1.5, and installs all dependencies.

### 2. Add performance env vars

```bash
echo 'export PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0' >> ~/.zshrc
echo 'export PYTORCH_ENABLE_MPS_FALLBACK=1' >> ~/.zshrc
source ~/.zshrc
```

### 3. Start everything

```bash
./scripts/start.sh
```

Open **http://localhost:5173** in your browser.

## How it works

1. Select one or more genres and optional mood keywords
2. Click **Start Radio**
3. A local LLM (Ollama + Qwen3) generates a creative song prompt
4. ACE-Step 1.5 generates a full MP3 with vocals
5. The song plays in your browser
6. The next song is pre-generated while the current one plays — seamless transitions

## Player controls

| Button | Action |
|--------|--------|
| ⏮ Rewind | Restart the current track from the beginning |
| ⏸ Stop | Stop the radio and return to genre selection |
| ⏭ Skip | Skip to the next track immediately |
| ↓ Save track | Download the current track as an MP3 file |

## Architecture

| Service       | Port  | Description                              |
|---------------|-------|------------------------------------------|
| Frontend      | 5173  | React + Vite (dev server)                |
| Backend       | 5555  | FastAPI (REST + WebSocket)               |
| ACE-Step API  | 8001  | Music generation (MLX / Apple Silicon)   |
| Ollama        | 11434 | LLM inference                            |

## LLM Model Selection

The LLM model is selected automatically at startup based on your machine's unified memory:

| Memory | Model | Why |
|--------|-------|-----|
| < 32 GB | `qwen3:8b` (5.2 GB) | Fast, fits dev machines |
| ≥ 32 GB | `qwen3:14b` (9.3 GB) | Richer creativity for production |

Override manually: `OLLAMA_MODEL=qwen3:14b ./scripts/start.sh`

## Debugging

All services write logs to `/tmp/`:

```bash
tail -f /tmp/generative-radio-backend.log   # FastAPI backend
tail -f /tmp/generative-radio-acestep.log   # ACE-Step API
tail -f /tmp/generative-radio-frontend.log  # Vite dev server
```

Backend log format: `HH:MM:SS [LEVEL] module: [component] message`

Frontend logs are in the browser DevTools console with `[WS]`, `[Radio]`, and `[Audio]` prefixes.

## Manual service control

```bash
# Override ACE-Step location
ACESTEP_PATH=/path/to/ACE-Step-1.5 ./scripts/start.sh

# Run backend directly with custom log level
cd backend
uvicorn main:app --port 5555 --log-level debug

# Run frontend
cd frontend
npm run dev
```

## Stopping

Press `Ctrl+C` in the terminal running `start.sh` — all services are shut down cleanly.
