# Generative Radio

A fully local, offline AI radio web app. Pick a genre, mood, vocal language, and tell it how you feel — the app generates and plays an endless stream of original AI-composed songs with no cloud APIs required.

## Requirements

- Mac with Apple Silicon (M1/M2/M3/M4)
- macOS 14+
- 16 GB+ unified memory (24 GB+ recommended for development, 64 GB for production)
- 50 GB+ free SSD space

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

**Development (hot-reload):**
```bash
./scripts/start.sh
```

**Production (compiled bundle, no reload):**
```bash
./scripts/start_prod.sh
```

Open **http://localhost:5173** in your browser.

When `cloudflared` is installed, a public URL is printed in the startup banner — share it to access the app from any device.

## How it works

1. Select a genre (24 options) and optional mood keywords (40 keywords in 3 display categories)
2. Choose a vocal language (11 languages) or instrumental mode
3. Optionally describe how you're feeling in free text
4. Optionally tune advanced ACE-Step parameters (time signature, inference steps, model variant)
5. Click **Start Radio**
6. A local LLM (Ollama + Qwen3.5) generates a dimension-based song prompt (style, instruments, mood, vocal style, production)
7. ACE-Step 1.5 generates a full MP3 with semantic audio codes for melodic structure
8. The song plays in your browser with a live activity log showing generation progress
9. The next song is pre-generated while the current one plays — the frontend pre-fetches audio bytes into memory for seamless, zero-latency transitions

## Multi-listener mode

Multiple browsers can connect to the same session. The first **local-network** connection becomes the **controller** — they pick genres, start/stop the radio, pin seeds with "More Like This", and see connected listeners. Everyone else joins as a **viewer** with a read-only player.

Remote visitors connecting via the Cloudflare tunnel always join as viewers regardless of order.

If the controller disconnects, the next **local** viewer is automatically promoted.

## "More Like This" seed pinning

The controller can toggle **More Like This** to pin the current track's generation seed. All subsequent tracks will use the same seed, producing similar sonic character while the LLM generates fresh lyrics and styles. Toggle off to return to random seeds.

## Supported languages

English, Español, Français, Deutsch, Italiano, 中文, Ελληνικά, Suomi, Svenska, 日本語, 한국어, and a **No Vocal** (instrumental) mode.

## Advanced options

The controller can configure ACE-Step parameters before starting:

| Option | Default | Range |
|---|---|---|
| Time Signature | Auto | 2/4, 3/4, 4/4, 6/8 |
| Inference Steps | 8 | 4–100 (more = higher quality, slower) |
| DiT Model Variant | turbo | turbo, turbo-shift1, turbo-shift3, turbo-continuous |

See the [ACE-Step 1.5 Tutorial](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/Tutorial.md) for details on what each parameter does.

## Remote access

`start.sh` supports two tunnel modes:

**Named tunnel (production):** If `~/.cloudflared/config.yml` is configured, the app is available at a fixed domain (e.g., `https://radio.scrambler-lab.com`). See `docs/cloudflare-named-tunnel-setup.md` for one-time setup.

**Quick tunnel (dev fallback):** If no named tunnel is configured, a random `*.trycloudflare.com` URL is generated on each startup.

Both modes proxy all traffic including WebSockets. Viewers joining via the tunnel automatically get the read-only listener experience.

## Architecture

| Service | Port | Description |
|---|---|---|
| Frontend | 5173 | React + Vite (dev HMR server or compiled preview, proxies /api and /ws) |
| Backend | 5555 | FastAPI (REST + WebSocket) |
| ACE-Step API | 8001 | Music generation (MLX / Apple Silicon) |
| Ollama | 11434 | LLM inference |
| Cloudflare Tunnel | — | Exposes port 5173 publicly (optional) |

See `BUILD_SPEC.md` for the full technical specification.

## LLM and audio duration

The app always uses **`qwen3.5:4b`** (~2.5 GB) for song prompt generation, generating 5 dimension fields (style, instruments, mood, vocal style, production) that are concatenated into a rich ACE-Step caption.

Audio duration is selected automatically at startup based on unified memory:

| Memory | Duration | Rationale |
|---|---|---|
| ≤ 32 GB | 30 s | Fast iteration on dev machines |
| 33–47 GB | 60 s | Safe within MLX VAE Metal buffer limits |
| ≥ 48 GB | 60 s → 120 s → 180 s | Progressive ramp — first track starts quickly, subsequent tracks get longer |

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

# Run frontend (dev, hot-reload)
cd frontend
npm run dev

# Run frontend (production preview of compiled bundle)
cd frontend
npm run build && npm run preview
```

## Stopping

Press `Ctrl+C` in the terminal running `start.sh` — the backend, frontend, and Cloudflare tunnel are all shut down cleanly.

ACE-Step is intentionally left running because it takes several minutes to warm up. To stop it manually, use the PID printed in the startup banner:

```bash
kill <ACESTEP_PID>
```
