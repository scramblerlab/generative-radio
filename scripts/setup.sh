#!/bin/bash
# One-time setup script for Generative Radio.
# Run from the project root: ./scripts/setup.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║       Generative Radio — Setup       ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── Homebrew ───────────────────────────────────────────────────────────────
if ! command -v brew &>/dev/null; then
  echo "[1/7] Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
  echo "[1/7] Homebrew already installed."
fi

# ── System tools ───────────────────────────────────────────────────────────
echo "[2/7] Installing system tools (python@3.11, node, ffmpeg, git-lfs)..."
brew install python@3.11 node ffmpeg git-lfs 2>/dev/null || true
git lfs install

# ── uv ─────────────────────────────────────────────────────────────────────
if ! command -v uv &>/dev/null; then
  echo "[3/7] Installing uv (Python package manager)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
else
  echo "[3/7] uv already installed."
fi

# ── Ollama ─────────────────────────────────────────────────────────────────
if ! command -v ollama &>/dev/null; then
  echo "[4/7] Installing Ollama..."
  brew install ollama
else
  echo "[4/7] Ollama already installed."
fi

# ollama pull requires the server to be running.
# Start it temporarily if it isn't already, and clean up afterwards.
echo ""
echo "  Pulling LLM models (this may take several minutes):"
echo "    qwen3:8b  — used on machines with <32GB unified memory"
echo "    qwen3:14b — used on machines with >=32GB unified memory"
echo "  The correct model is auto-selected at runtime via config.py."
echo ""
echo "  Note: 'MLX dynamic library not available' warnings from Ollama are"
echo "  harmless — it falls back to Metal automatically."
echo ""

SETUP_OLLAMA_PID=""
if ! curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
  echo "  Ollama server not running — starting temporarily for model pull..."
  ollama serve > /tmp/generative-radio-setup-ollama.log 2>&1 &
  SETUP_OLLAMA_PID=$!

  echo "  Waiting for Ollama to become ready..."
  WAIT=0
  until curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; do
    sleep 1
    WAIT=$((WAIT + 1))
    if [ $WAIT -ge 30 ]; then
      echo ""
      echo "  ERROR: Ollama did not start within 30s."
      echo "  Check the log: /tmp/generative-radio-setup-ollama.log"
      exit 1
    fi
  done
  echo "  Ollama ready."
else
  echo "  Ollama server already running — pulling directly."
fi

ollama pull qwen3:8b
ollama pull qwen3:14b

# Stop the temporary Ollama instance if we started it
if [[ -n "$SETUP_OLLAMA_PID" ]]; then
  echo "  Stopping temporary Ollama server..."
  kill "$SETUP_OLLAMA_PID" 2>/dev/null
  wait "$SETUP_OLLAMA_PID" 2>/dev/null || true
fi

# ── ACE-Step 1.5 ───────────────────────────────────────────────────────────
ACESTEP_DIR="${ACESTEP_PATH:-$(dirname "$PROJECT_DIR")/ACE-Step-1.5}"
echo "[5/7] Checking for ACE-Step 1.5 at: $ACESTEP_DIR"
if [ ! -d "$ACESTEP_DIR" ]; then
  echo "  Cloning ACE-Step 1.5 (model weights download happens on first API start)..."
  git clone https://github.com/ACE-Step/ACE-Step-1.5.git "$ACESTEP_DIR"
  echo "  Running uv sync..."
  cd "$ACESTEP_DIR" && uv sync && cd "$PROJECT_DIR"
else
  echo "  ACE-Step 1.5 found. Skipping clone."
fi

# ── Backend ────────────────────────────────────────────────────────────────
echo "[6/7] Installing backend Python dependencies..."
cd "$PROJECT_DIR/backend"

# Create a virtual environment if one doesn't exist yet
if [ ! -d ".venv" ]; then
  echo "  Creating Python virtual environment at backend/.venv ..."
  python3 -m venv .venv
fi

echo "  Activating venv and installing dependencies..."
source .venv/bin/activate
pip install -r requirements.txt
deactivate

cd "$PROJECT_DIR"

# ── Frontend ───────────────────────────────────────────────────────────────
echo "[7/7] Installing frontend Node dependencies..."
cd "$PROJECT_DIR/frontend"
npm install
cd "$PROJECT_DIR"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║         Setup complete!              ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "  Add these lines to ~/.zshrc for optimal MPS performance:"
echo "    export PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0"
echo "    export PYTORCH_ENABLE_MPS_FALLBACK=1"
echo ""
echo "  Then run:  ./scripts/start.sh"
echo ""
