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
  echo "[1/8] Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
  echo "[1/8] Homebrew already installed."
fi

# ── System tools ───────────────────────────────────────────────────────────
echo "[2/8] Installing system tools (python@3.11, node, ffmpeg, git-lfs, cloudflared)..."
brew install python@3.11 node ffmpeg git-lfs 2>/dev/null || true
brew install cloudflare/cloudflare/cloudflared 2>/dev/null || true
git lfs install

# ── uv ─────────────────────────────────────────────────────────────────────
if ! command -v uv &>/dev/null; then
  echo "[3/8] Installing uv (Python package manager)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
else
  echo "[3/8] uv already installed."
fi

# ── Ollama ─────────────────────────────────────────────────────────────────
if ! command -v ollama &>/dev/null; then
  echo "[4/8] Installing Ollama..."
  brew install ollama
else
  echo "[4/8] Ollama already installed."
fi

# ollama pull requires the server to be running.
# Start it temporarily if it isn't already, and clean up afterwards.
echo ""
echo "  Pulling LLM models (this may take several minutes):"
echo "    qwen3.5:4b   — used on machines with ≥ 32 GB unified memory"
echo "    qwen3.5:0.8b — used on machines with < 32 GB unified memory (faster)"
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

_ollama_pull() {
  local MODEL="$1"
  local PULL_TMPFILE
  PULL_TMPFILE=$(mktemp)
  ollama pull "$MODEL" 2>&1 | tee "$PULL_TMPFILE"
  local PULL_EXIT=${PIPESTATUS[0]}
  local PULL_OUTPUT
  PULL_OUTPUT=$(cat "$PULL_TMPFILE")
  rm -f "$PULL_TMPFILE"
  if echo "$PULL_OUTPUT" | grep -qi "requires a newer version of ollama"; then
    echo ""
    echo "  ERROR: Your Ollama version is too old to run $MODEL."
    echo "  Please update Ollama and re-run this script:"
    echo ""
    echo "    brew upgrade ollama"
    echo ""
    echo "  Or download the latest version from https://ollama.com/download"
    exit 1
  fi
  if [ $PULL_EXIT -ne 0 ]; then
    echo ""
    echo "  ERROR: ollama pull $MODEL failed (exit code $PULL_EXIT)."
    echo "  Check the output above for details."
    exit 1
  fi
}

_ollama_pull qwen3.5:4b
_ollama_pull qwen3.5:0.8b

# Stop the temporary Ollama instance if we started it
if [[ -n "$SETUP_OLLAMA_PID" ]]; then
  echo "  Stopping temporary Ollama server..."
  kill "$SETUP_OLLAMA_PID" 2>/dev/null
  wait "$SETUP_OLLAMA_PID" 2>/dev/null || true
fi

# ── ACE-Step 1.5 ───────────────────────────────────────────────────────────
ACESTEP_DIR="${ACESTEP_PATH:-$(dirname "$PROJECT_DIR")/ACE-Step-1.5}"
echo "[5/8] Checking for ACE-Step 1.5 at: $ACESTEP_DIR"
if [ ! -d "$ACESTEP_DIR" ]; then
  echo "  Cloning ACE-Step 1.5 (model weights download happens on first API start)..."
  git clone https://github.com/ACE-Step/ACE-Step-1.5.git "$ACESTEP_DIR"
  echo "  Running uv sync..."
  cd "$ACESTEP_DIR" && uv sync && cd "$PROJECT_DIR"
else
  echo "  ACE-Step 1.5 found. Pulling latest changes..."
  cd "$ACESTEP_DIR" && git pull && uv sync && cd "$PROJECT_DIR"
fi

# ── Backend ────────────────────────────────────────────────────────────────
echo "[6/8] Installing backend Python dependencies..."
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

# ── Auth configuration ─────────────────────────────────────────────────────
# JWT_SECRET signs session tokens; INVITE_CODE gates signup. Kept outside the
# repo so they never reach git, and read at startup by backend/config.py.
ENV_FILE="$HOME/.generative-radio.env"
echo "[7/8] Configuring authentication..."
if [ -f "$ENV_FILE" ]; then
  echo "  $ENV_FILE already exists — leaving it untouched."
  EXISTING_CODE=$(grep -E '^INVITE_CODE=' "$ENV_FILE" | head -1 | cut -d= -f2-)
  [ -n "$EXISTING_CODE" ] && echo "  Current invite code: $EXISTING_CODE"
else
  GENERATED_SECRET=$(openssl rand -hex 32)
  echo ""
  echo "  Signup is invite-only. Choose an invite code to share with people you"
  echo "  want to let register (press Enter to generate a random one)."
  read -r -p "  Invite code: " CHOSEN_CODE
  if [ -z "$CHOSEN_CODE" ]; then
    CHOSEN_CODE=$(openssl rand -hex 8)
  fi
  cat > "$ENV_FILE" <<EOF
# Generative Radio — secrets. Created by scripts/setup.sh.
# Loaded at startup by backend/config.py. Never commit this file.
JWT_SECRET=$GENERATED_SECRET
INVITE_CODE=$CHOSEN_CODE
JWT_EXPIRE_DAYS=30
EOF
  chmod 600 "$ENV_FILE"
  echo "  Wrote $ENV_FILE (chmod 600)."
fi

# ── Frontend ───────────────────────────────────────────────────────────────
echo "[8/8] Installing frontend Node dependencies..."
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
INVITE_CODE_OUT=$(grep -E '^INVITE_CODE=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
if [ -n "$INVITE_CODE_OUT" ]; then
  echo "  ┌─ Signup invite code ──────────────────────────────────────────┐"
  printf "  │  %-60s │\n" "$INVITE_CODE_OUT"
  echo "  │  Share this with anyone you want to let register.             │"
  echo "  │  Stored in ~/.generative-radio.env — change it any time.      │"
  echo "  └───────────────────────────────────────────────────────────────┘"
  echo ""
fi
