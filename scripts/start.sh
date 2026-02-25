#!/bin/bash
# Start all Generative Radio services.
# Run from the project root: ./scripts/start.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ACESTEP_DIR="${ACESTEP_PATH:-$(dirname "$PROJECT_DIR")/ACE-Step-1.5}"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║      Generative Radio — Starting     ║"
echo "╚══════════════════════════════════════╝"
echo ""

# macOS / Apple Silicon performance env vars
export PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0
export PYTORCH_ENABLE_MPS_FALLBACK=1

# Ensure uv (installed to ~/.local/bin by astral.sh installer) is on PATH
export PATH="$HOME/.local/bin:$PATH"

# ── 1. Ollama ──────────────────────────────────────────────────────────────
OLLAMA_PID=""
if pgrep -x "ollama" > /dev/null 2>&1; then
  echo "[1/5] Ollama already running."
else
  echo "[1/5] Starting Ollama..."
  ollama serve > /tmp/generative-radio-ollama.log 2>&1 &
  OLLAMA_PID=$!
  echo "  Ollama PID: $OLLAMA_PID  (log: /tmp/generative-radio-ollama.log)"
  sleep 2
fi

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
  # Capture PID so it shows in the shutdown message, but we won't kill it on exit either way
  ACESTEP_PID=$(lsof -ti tcp:8001 2>/dev/null | head -1 || echo "unknown")
else
  echo "[2/5] Starting ACE-Step 1.5 API server..."
  cd "$ACESTEP_DIR"
  ACESTEP_LM_BACKEND=mlx \
  TOKENIZERS_PARALLELISM=false \
    uv run acestep-api --host 127.0.0.1 --port 8001 \
    > /tmp/generative-radio-acestep.log 2>&1 &
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

# ── 3. FastAPI Backend ─────────────────────────────────────────────────────
echo "[3/5] Starting FastAPI backend..."

# Clear any stale process still holding port 5555 (e.g. from a previous run)
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
  --reload \
  --log-level info \
  > /tmp/generative-radio-backend.log 2>&1 &
BACKEND_PID=$!
cd "$PROJECT_DIR"
echo "  Backend PID: $BACKEND_PID  (log: /tmp/generative-radio-backend.log)"

# ── 4. Frontend Dev Server ─────────────────────────────────────────────────
echo "[4/5] Starting frontend dev server..."

# Clear any stale process still holding port 5173
STALE_FRONTEND=$(lsof -ti tcp:5173 2>/dev/null || true)
if [[ -n "$STALE_FRONTEND" ]]; then
  echo "  Clearing stale frontend process on port 5173 (PID $STALE_FRONTEND)..."
  kill -9 $STALE_FRONTEND 2>/dev/null || true
  sleep 1
fi

cd "$PROJECT_DIR/frontend"
npm run dev > /tmp/generative-radio-frontend.log 2>&1 &
FRONTEND_PID=$!
cd "$PROJECT_DIR"
echo "  Frontend PID: $FRONTEND_PID  (log: /tmp/generative-radio-frontend.log)"

# ── 5. Cloudflare Tunnel ────────────────────────────────────────────────────
echo "[5/5] Starting Cloudflare tunnel..."
CLOUDFLARED_PID=""
TUNNEL_URL=""

# Named tunnel name — must match `cloudflared tunnel create <NAME>` from one-time setup.
# Override via TUNNEL_NAME env var if your tunnel has a different name.
CF_TUNNEL_NAME="${TUNNEL_NAME:-generative-radio}"
CF_TUNNEL_DOMAIN="${TUNNEL_DOMAIN:-radio.scrambler-lab.com}"

if ! command -v cloudflared &>/dev/null; then
  echo "  cloudflared not found — skipping tunnel. Run ./scripts/setup.sh to install."
elif [ -f "$HOME/.cloudflared/config.yml" ]; then
  # Named tunnel — permanent fixed domain (see docs/cloudflare-named-tunnel-setup.md)
  echo "  Named tunnel config found — starting tunnel '$CF_TUNNEL_NAME'..."
  cloudflared tunnel run "$CF_TUNNEL_NAME" \
    > /tmp/generative-radio-cloudflared.log 2>&1 &
  CLOUDFLARED_PID=$!
  TUNNEL_URL="https://$CF_TUNNEL_DOMAIN"
  echo "  Cloudflared PID: $CLOUDFLARED_PID  (log: /tmp/generative-radio-cloudflared.log)"
  echo "  Fixed URL: $TUNNEL_URL"
else
  # Quick tunnel fallback — random URL (for dev machines without named tunnel setup)
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
echo "║       Generative Radio is live!              ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Local:      http://localhost:5173           ║"
echo "║  Remote:     $TUNNEL_URL"
echo "║                                              ║"
echo "║  Backend:    http://localhost:5555           ║"
echo "║  ACE-Step:   http://localhost:8001           ║"
echo "║  Ollama:     http://localhost:11434          ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Logs:                                       ║"
echo "║    Backend:  /tmp/generative-radio-backend.log    ║"
echo "║    ACE-Step: /tmp/generative-radio-acestep.log    ║"
echo "║    Tunnel:   /tmp/generative-radio-cloudflared.log║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Press Ctrl+C to stop all services."
echo ""

# Shutdown hook — stop the app (backend + frontend + tunnel + optionally Ollama),
# but intentionally leave ACE-Step running. ACE-Step takes minutes to warm
# up and may be mid-generation; killing it here costs you the next restart.
# To stop ACE-Step manually: kill <PID shown above>
cleanup() {
  echo ""
  echo "Shutting down backend, frontend, and tunnel..."
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
  [[ -n "$CLOUDFLARED_PID" ]] && kill "$CLOUDFLARED_PID" 2>/dev/null
  [[ -n "$OLLAMA_PID" ]] && kill "$OLLAMA_PID" 2>/dev/null
  echo ""
  echo "  ⚠  ACE-Step (PID $ACESTEP_PID) is still running."
  echo "     To stop it: kill $ACESTEP_PID"
  echo ""
  echo "Done."
  exit 0
}
trap cleanup INT TERM

wait
