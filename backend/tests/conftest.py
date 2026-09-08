"""Test fixtures.

Every test points USERS_DB_PATH at a tmp_path and sets the auth env vars before
importing the modules under test, so nothing here touches the real users.db or
the developer's ~/.generative-radio.env.
"""

import importlib
import os
import sys
from pathlib import Path

import pytest

# backend/ is not a package — the app runs with it as the working directory.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

TEST_SECRET = "test-secret-do-not-use-in-production"
TEST_INVITE = "test-invite-code"


@pytest.fixture
def auth_env(tmp_path, monkeypatch):
    """Isolated auth configuration + a fresh empty database."""
    monkeypatch.setenv("JWT_SECRET", TEST_SECRET)
    monkeypatch.setenv("INVITE_CODE", TEST_INVITE)
    monkeypatch.setenv("JWT_EXPIRE_DAYS", "30")
    monkeypatch.setenv("COOKIE_SECURE", "0")
    monkeypatch.setenv("USERS_DB_PATH", str(tmp_path / "users.db"))

    import users
    importlib.reload(users)   # DB_PATH is resolved at import time
    users.init_db()

    import ratelimit
    ratelimit.reset()         # buckets are module-level and leak across tests
    yield
    ratelimit.reset()


@pytest.fixture
def client(auth_env):
    """TestClient over a bare FastAPI app with only the auth router mounted.

    Importing backend/main.py instead would construct the OllamaClient,
    ACEStepClient and RadioOrchestrator singletons and try to reach Ollama.
    """
    import importlib
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import routers.auth as auth_routes
    importlib.reload(auth_routes)   # rebind its `users` module to the reloaded one

    app = FastAPI()
    app.include_router(auth_routes.router)
    with TestClient(app) as c:
        yield c
