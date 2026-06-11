#!/bin/bash
# Start Generative Radio in PRODUCTION mode.
#
# Differences from start.sh (dev mode):
#   - Clears all caches and does a fresh frontend build (npm run build)
#   - Serves the compiled static bundle via Vite preview (not the dev HMR server)
#   - Runs the FastAPI backend without --reload
#
# Run from the project root: ./scripts/start_prod.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ACESTEP_DIR="${ACESTEP_PATH:-$(dirname "$PROJECT_DIR")/ACE-Step-1.5}"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   Generative Radio — Production      ║"
echo "╚══════════════════════════════════════╝"
echo ""

# macOS / Apple Silicon performance env vars
export PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0
export PYTORCH_ENABLE_MPS_FALLBACK=1

# Ensure uv (installed to ~/.local/bin by astral.sh installer) is on PATH
export PATH="$HOME/.local/bin:$PATH"

# ── 0. Clean build ─────────────────────────────────────────────────────────
echo "[0/5] Cleaning caches and building frontend..."

# Clear Vite transform cache
if [ -d "$PROJECT_DIR/frontend/node_modules/.vite" ]; then
  echo "  Clearing Vite cache..."
  rm -rf "$PROJECT_DIR/frontend/node_modules/.vite"
fi

# Clear previous build output
if [ -d "$PROJECT_DIR/frontend/dist" ]; then
  echo "  Clearing previous dist/..."
  rm -rf "$PROJECT_DIR/frontend/dist"
fi

# Install/update npm dependencies (run from root so patch-package postinstall works)
echo "  Installing npm dependencies..."
cd "$PROJECT_DIR"
npm ci --prefer-offline

# Compile production bundle
echo "  Building frontend (npm run build)..."
cd "$PROJECT_DIR/frontend"
npm run build
cd "$PROJECT_DIR"
echo "  Frontend build complete — output: frontend/dist/"

# ── 1. aimodel proxy ──────────────────────────────────────────────────────
# Ollama is managed by aimodel — this app connects through the proxy on :11430.
PROXY_URL="http://127.0.0.1:11430"
OLLAMA_PID=""
if curl -sf "$PROXY_URL/health" &>/dev/null; then
  echo "[1/5] aimodel proxy ready on $PROXY_URL"
else
  echo ""
  echo "  ERROR: aimodel proxy not running."
  echo "  Start it first:  cd $(dirname "$SCRIPT_DIR")/aimodel && ./start.sh"
  echo ""
  exit 1
fi

# Point the ollama Python SDK at the proxy port.
export OLLAMA_HOST="$PROXY_URL"

# ── 2. ACE-Step API ────────────────────────────────────────────────────────
if [ ! -d "$ACESTEP_DIR" ]; then
  echo ""
  echo "  ERROR: ACE-Step not found at $ACESTEP_DIR"
  echo "  Run ./scripts/setup.sh first, or set ACESTEP_PATH=/path/to/ACE-Step-1.5"
  echo ""
  exit 1
fi

if curl -sf http://localhost:8001/health > /dev/null 2>&1; then
  echo "[2/5] ACE-Step API already running — reusing existing process."
  ACESTEP_PID=$(lsof -ti tcp:8001 2>/dev/null | head -1 || echo "unknown")
else
  echo "[2/5] Starting ACE-Step 1.5 API server..."
  cd "$ACESTEP_DIR"
  ACESTEP_LM_BACKEND=mlx \
  ACESTEP_LM_MODEL_PATH=acestep-5Hz-lm-1.7B \
  ACESTEP_CONFIG_PATH=acestep-v15-xl-turbo \
  ACESTEP_COMPILE_MODEL=1 \
  ACESTEP_MLX_VAE_FP16=1 \
  MLX_METAL_JIT=1 \
  ACESTEP_DEBUG_STATS=1 \
  TOKENIZERS_PARALLELISM=false \
  TQDM_DISABLE=1 \
  ACESTEP_DISABLE_TQDM=1 \
    uv run acestep-api --host 127.0.0.1 --port 8001 \
    < /dev/null > /tmp/generative-radio-acestep.log 2>&1 &
  ACESTEP_PID=$!
  cd "$PROJECT_DIR"
  echo "  ACE-Step PID: $ACESTEP_PID  (log: /tmp/generative-radio-acestep.log)"

  echo "  Waiting for ACE-Step API to become ready (this can take up to 60 minutes on first run)..."
  WAIT=0
  until curl -sf http://localhost:8001/health > /dev/null 2>&1; do
    sleep 3
    WAIT=$((WAIT + 3))
    if [ $WAIT -ge 3600 ]; then
      echo ""
      echo "  ERROR: ACE-Step did not start within 60 minutes."
      echo "  Check the log: /tmp/generative-radio-acestep.log"
      echo ""
      kill $ACESTEP_PID 2>/dev/null
      exit 1
    fi
  done
  echo "  ACE-Step API ready (after ${WAIT}s)."
fi

# ── 3. FastAPI Backend (no --reload in production) ─────────────────────────
echo "[3/5] Starting FastAPI backend (production mode)..."
echo ""
echo "  ┌─ CORS allowed origins (production) ──────────────────────────┐"
echo "  │  http://localhost:5173                                        │"
echo "  │  http://127.0.0.1:5173                                        │"
echo "  │  https://radio.scrambler-lab.com                             │"
echo "  │                                                               │"
echo "  │  ⚠  Quick-tunnel URLs (*.trycloudflare.com) are BLOCKED.     │"
echo "  │     Use ./scripts/start.sh for dev with quick-tunnel access. │"
echo "  └───────────────────────────────────────────────────────────────┘"
echo ""

STALE_BACKEND=$(lsof -ti tcp:5555 2>/dev/null || true)
if [[ -n "$STALE_BACKEND" ]]; then
  echo "  Clearing stale backend process on port 5555 (PID $STALE_BACKEND)..."
  kill -9 $STALE_BACKEND 2>/dev/null || true
  sleep 1
fi

VENV="$PROJECT_DIR/backend/.venv"
if [ ! -f "$VENV/bin/uvicorn" ]; then
  echo ""
  echo "  ERROR: Python venv not found at backend/.venv"
  echo "  Run ./scripts/setup.sh first."
  echo ""
  exit 1
fi

cd "$PROJECT_DIR/backend"
"$VENV/bin/uvicorn" main:app \
  --host 127.0.0.1 \
  --port 5555 \
  --log-level info \
  > /tmp/generative-radio-backend.log 2>&1 &
BACKEND_PID=$!
cd "$PROJECT_DIR"
echo "  Backend PID: $BACKEND_PID  (log: /tmp/generative-radio-backend.log)"

# ── 4. Vite Preview Server (serves compiled bundle) ────────────────────────
echo "[4/5] Starting Vite preview server (compiled bundle)..."

STALE_FRONTEND=$(lsof -ti tcp:5173 2>/dev/null || true)
if [[ -n "$STALE_FRONTEND" ]]; then
  echo "  Clearing stale frontend process on port 5173 (PID $STALE_FRONTEND)..."
  kill -9 $STALE_FRONTEND 2>/dev/null || true
  sleep 1
fi

cd "$PROJECT_DIR/frontend"
npm run preview < /dev/null > /tmp/generative-radio-frontend.log 2>&1 &
FRONTEND_PID=$!
cd "$PROJECT_DIR"
echo "  Preview PID: $FRONTEND_PID  (log: /tmp/generative-radio-frontend.log)"

# ── 5. Cloudflare Tunnel ────────────────────────────────────────────────────
echo "[5/5] Starting Cloudflare tunnel..."
CLOUDFLARED_PID=""
TUNNEL_URL=""

CF_TUNNEL_NAME="${TUNNEL_NAME:-generative-radio}"
CF_TUNNEL_DOMAIN="${TUNNEL_DOMAIN:-radio.scrambler-lab.com}"

if ! command -v cloudflared &>/dev/null; then
  echo "  cloudflared not found — skipping tunnel. Run ./scripts/setup.sh to install."
elif [ -f "$HOME/.cloudflared/config.yml" ]; then
  echo "  Named tunnel config found — starting tunnel '$CF_TUNNEL_NAME'..."
  cloudflared tunnel run "$CF_TUNNEL_NAME" \
    > /tmp/generative-radio-cloudflared.log 2>&1 &
  CLOUDFLARED_PID=$!
  TUNNEL_URL="https://$CF_TUNNEL_DOMAIN"
  echo "  Cloudflared PID: $CLOUDFLARED_PID  (log: /tmp/generative-radio-cloudflared.log)"
  echo "  Fixed URL: $TUNNEL_URL"
else
  echo "  No named tunnel config — falling back to quick tunnel (random URL)..."
  cloudflared tunnel --url http://localhost:5173 \
    > /tmp/generative-radio-cloudflared.log 2>&1 &
  CLOUDFLARED_PID=$!
  echo "  Cloudflared PID: $CLOUDFLARED_PID  (log: /tmp/generative-radio-cloudflared.log)"

  echo "  Waiting for tunnel URL..."
  WAIT=0
  until [[ -n "$TUNNEL_URL" ]]; do
    sleep 1
    WAIT=$((WAIT + 1))
    TUNNEL_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' \
      /tmp/generative-radio-cloudflared.log 2>/dev/null | head -1 || true)
    if [ $WAIT -ge 30 ]; then
      echo "  WARNING: Tunnel URL not found after 30s — check /tmp/generative-radio-cloudflared.log"
      TUNNEL_URL="(unavailable — see log)"
      break
    fi
  done
fi

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║    Generative Radio is live! (PRODUCTION)    ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Local:      http://localhost:5173           ║"
echo "║  Remote:     $TUNNEL_URL"
echo "║                                              ║"
echo "║  Backend:    http://localhost:5555           ║"
echo "║  ACE-Step:   http://localhost:8001           ║"
echo "║  Ollama:     http://127.0.0.1:11430 (proxy)  ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Logs:                                       ║"
echo "║    Backend:  /tmp/generative-radio-backend.log    ║"
echo "║    ACE-Step: /tmp/generative-radio-acestep.log    ║"
echo "║    Tunnel:   /tmp/generative-radio-cloudflared.log║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Press Ctrl+C to stop all services."
echo ""

# TERM a process and all of its descendants (npm→vite, uv→python, etc.).
kill_tree() {
  local pid=$1 child
  [[ -z "$pid" || "$pid" == "unknown" ]] && return
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

# Kill whatever is listening on a TCP port (catches re-parented stragglers).
kill_port() {
  local pids
  pids=$(lsof -ti tcp:"$1" 2>/dev/null || true)
  [[ -n "$pids" ]] && kill $pids 2>/dev/null || true
}

# Shutdown hook — stops backend, frontend, tunnel, and (by default) ACE-Step.
# Set KEEP_ACESTEP=1 to leave ACE-Step running across restarts and skip its
# multi-minute model reload next time.
cleanup() {
  trap - INT TERM  # don't re-enter on a second Ctrl+C
  echo ""
  echo "Shutting down backend, frontend, and tunnel..."
  kill_tree "$BACKEND_PID";  kill_port 5555
  kill_tree "$FRONTEND_PID"; kill_port 5173
  [[ -n "$CLOUDFLARED_PID" ]] && kill_tree "$CLOUDFLARED_PID"
  # Ollama is managed by aimodel — use aimodel/stop.sh to shut it down.

  if [[ "${KEEP_ACESTEP:-0}" == "1" ]]; then
    echo "  KEEP_ACESTEP=1 — leaving ACE-Step (PID $ACESTEP_PID) running."
  else
    echo "  Stopping ACE-Step..."
    kill_tree "$ACESTEP_PID"; kill_port 8001
  fi

  # Grace period, then force-kill anything still holding our ports.
  sleep 2
  PORTS="5555 5173"
  [[ "${KEEP_ACESTEP:-0}" == "1" ]] || PORTS="$PORTS 8001"
  for port in $PORTS; do
    pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
    [[ -n "$pids" ]] && kill -9 $pids 2>/dev/null || true
  done

  echo "Done."
  exit 0
}
trap cleanup INT TERM

wait
