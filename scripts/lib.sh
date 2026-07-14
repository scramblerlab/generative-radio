#!/bin/bash
# Shared helpers sourced by start.sh / start_prod.sh.

# Ensure backend/.venv exists and its interpreter still resolves.
#
# venv console-script shebangs (e.g. backend/.venv/bin/uvicorn) bake in an
# absolute path at creation time. Renaming or moving the project directory
# leaves that shebang pointing at a path that no longer exists, so the venv
# looks present on disk but fails with "bad interpreter" the moment anything
# tries to run it. Detect that and rebuild the venv in place instead of
# failing deep inside a background process.
ensure_backend_venv() {
  local project_dir="$1"
  local venv="$project_dir/backend/.venv"

  if [ ! -f "$venv/bin/uvicorn" ]; then
    echo ""
    echo "  ERROR: Python venv not found at backend/.venv"
    echo "  Run ./scripts/setup.sh first."
    echo ""
    exit 1
  fi

  local shebang interpreter
  shebang=$(head -1 "$venv/bin/uvicorn")
  interpreter="${shebang#\#!}"

  if [ ! -x "$interpreter" ]; then
    echo ""
    echo "  WARNING: backend/.venv is stale (interpreter not found: $interpreter)."
    echo "  This usually happens after the project directory is renamed or moved."
    echo "  Rebuilding backend/.venv..."
    rm -rf "$venv"
    (
      cd "$project_dir/backend"
      python3 -m venv .venv
      source .venv/bin/activate
      pip install -q -r requirements.txt
      deactivate
    )
    echo "  backend/.venv rebuilt."
    echo ""
  fi
}
