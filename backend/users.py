"""SQLite-backed user store.

Deliberately stdlib `sqlite3` rather than SQLAlchemy + Alembic: this is the only
table the project has, uvicorn runs single-process, and auth traffic is a handful
of requests per day. The schema ladder below follows the same PRAGMA user_version
pattern the rest of the ecosystem uses, so future columns are additive.

Every call opens a short-lived connection. Callers must run these functions in a
worker thread (`asyncio.to_thread`) — never on the event loop, which is busy
broadcasting WebSocket frames to every listener.
"""

import logging
import os
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

DB_PATH = Path(os.getenv("USERS_DB_PATH", Path(__file__).parent / "users.db"))

_SCHEMA_VERSION = 1


@dataclass(frozen=True, slots=True)
class UserRecord:
    id: str
    email: str
    nickname: str
    password_hash: str
    created_at: str
    last_login_at: str | None
    disabled: bool


class EmailTakenError(Exception):
    """Signup attempted with an email that already exists."""


class NicknameTakenError(Exception):
    """Signup attempted with a nickname that already exists (case-insensitively)."""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    """Create the schema if absent. Idempotent — safe to call on every startup."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version < 1:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                  id            TEXT PRIMARY KEY,
                  email         TEXT NOT NULL,
                  nickname      TEXT NOT NULL,
                  password_hash TEXT NOT NULL,
                  created_at    TEXT NOT NULL,
                  last_login_at TEXT,
                  disabled      INTEGER NOT NULL DEFAULT 0
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
                  ON users(email);
                -- Case-insensitive: the nickname is broadcast globally as the DJ
                -- name and burned into every generated track's metadata, so two
                -- users differing only by case would be indistinguishable.
                CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname
                  ON users(lower(nickname));
                """
            )
            conn.execute(f"PRAGMA user_version = {_SCHEMA_VERSION}")
            logger.info(f"[users] Schema initialized at {DB_PATH}")


def _row_to_user(row: sqlite3.Row) -> UserRecord:
    return UserRecord(
        id=row["id"],
        email=row["email"],
        nickname=row["nickname"],
        password_hash=row["password_hash"],
        created_at=row["created_at"],
        last_login_at=row["last_login_at"],
        disabled=bool(row["disabled"]),
    )


def create_user(email: str, nickname: str, password_hash: str) -> UserRecord:
    """Insert a new user. Raises EmailTakenError / NicknameTakenError on conflict.

    `email` is expected pre-normalized (stripped + lowercased) by the caller.
    """
    now = datetime.now(timezone.utc).isoformat()
    user = UserRecord(
        id=uuid.uuid4().hex,
        email=email,
        nickname=nickname,
        password_hash=password_hash,
        created_at=now,
        last_login_at=None,
        disabled=False,
    )
    try:
        with _connect() as conn:
            conn.execute(
                "INSERT INTO users (id, email, nickname, password_hash, created_at, "
                "last_login_at, disabled) VALUES (?, ?, ?, ?, ?, NULL, 0)",
                (user.id, user.email, user.nickname, user.password_hash, user.created_at),
            )
    except sqlite3.IntegrityError as e:
        # Classify by querying rather than by parsing the error message: SQLite
        # words it differently for a column index ("UNIQUE constraint failed:
        # users.email") than for the expression index on lower(nickname)
        # ("...failed: index 'idx_users_nickname'"), and neither shape is API.
        with _connect() as conn:
            if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
                raise EmailTakenError(email) from e
            if conn.execute(
                "SELECT 1 FROM users WHERE lower(nickname) = lower(?)", (nickname,)
            ).fetchone():
                raise NicknameTakenError(nickname) from e
        raise
    logger.info(f"[users] Created user {user.id} nickname={nickname!r}")
    return user


def get_by_email(email: str) -> UserRecord | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    return _row_to_user(row) if row else None


def get_by_id(user_id: str) -> UserRecord | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return _row_to_user(row) if row else None


def touch_last_login(user_id: str) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE users SET last_login_at = ? WHERE id = ?",
            (datetime.now(timezone.utc).isoformat(), user_id),
        )


def count_users() -> int:
    with _connect() as conn:
        return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
