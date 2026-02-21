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

This installs Homebrew tools, Ollama, the LLM model, clones ACE-Step 1.5, installs all dependencies, and installs `cloudflared` for remote access.

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

When `cloudflared` is installed, a free public URL is printed in the startup banner — share it to access the app from any device on the internet.

## How it works

1. Select one or more genres and optional mood keywords
2. Click **Start Radio**
3. A local LLM (Ollama + Qwen3) generates a creative song prompt
4. ACE-Step 1.5 generates a full MP3 with vocals
5. The song plays in your browser with a live activity log showing generation progress
6. The next song is pre-generated while the current one plays — seamless transitions

## Player controls

| Button | Action |
|--------|--------|
| ⏮ Rewind | Restart the current track from the beginning |
| ⏸ Stop | Stop the radio and return to genre selection |

## Remote access

`start.sh` automatically starts a [Cloudflare Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) on port 5173. When the tunnel is ready, the URL appears in the startup banner:

```
║  Local:      http://localhost:5173           ║
║  Remote:     https://xxxx-xxxx.trycloudflare.com
```

Share the remote URL with anyone — it works on any device without port forwarding or a static IP.

**How it works:** The Vite dev server proxies all backend traffic (`/api/...`, `/ws`) internally on the Mac Mini, so a single tunnel on port 5173 exposes the full app including WebSockets. No tunnel-side configuration is needed.

**Note:** Cloudflare Quick Tunnels are ephemeral — the URL changes each time `start.sh` is run. For a stable permanent URL, set up a [named Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/) with your own domain.

## Architecture

| Service           | Port  | Description                                   |
|-------------------|-------|-----------------------------------------------|
| Frontend          | 5173  | React + Vite (dev server, proxies /api and /ws) |
| Backend           | 5555  | FastAPI (REST + WebSocket)                    |
| ACE-Step API      | 8001  | Music generation (MLX / Apple Silicon)        |
| Ollama            | 11434 | LLM inference                                 |
| Cloudflare Tunnel | —     | Exposes port 5173 publicly (optional)         |

## LLM and audio duration

The app always uses **`qwen3:8b`** (5.2 GB) for song prompt generation. Using the smaller model frees memory for ACE-Step's Metal buffers, which is the primary performance bottleneck.

Audio duration is selected automatically at startup based on unified memory:

| Memory | Max duration | Rationale |
|--------|-------------|-----------|
| < 48 GB | 60 s | Safe within MLX VAE Metal buffer limits |
| ≥ 48 GB | 180 s | Sufficient Metal headroom on 64 GB machines |

See `docs/acestep-memory-vs-duration.md` for the full memory vs. duration analysis.

## Debugging

All services write logs to `/tmp/`:

```bash
tail -f /tmp/generative-radio-backend.log     # FastAPI backend
tail -f /tmp/generative-radio-acestep.log     # ACE-Step API
tail -f /tmp/generative-radio-frontend.log    # Vite dev server
tail -f /tmp/generative-radio-cloudflared.log # Cloudflare tunnel
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

Press `Ctrl+C` in the terminal running `start.sh` — the backend, frontend, and Cloudflare tunnel are all shut down cleanly.

ACE-Step is intentionally left running because it takes several minutes to warm up. To stop it manually, use the PID printed in the startup banner:

```bash
kill <ACESTEP_PID>
```
