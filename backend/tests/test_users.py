"""Store-level tests: schema, uniqueness, and the disabled flag."""

import pytest

import users


def test_init_db_is_idempotent(auth_env):
    users.init_db()
    users.init_db()
    assert users.count_users() == 0


def test_create_and_fetch(auth_env):
    created = users.create_user("nobu@example.com", "Nobu", "hash")
    assert users.count_users() == 1

    by_email = users.get_by_email("nobu@example.com")
    assert by_email == created
    assert by_email.disabled is False
    assert by_email.last_login_at is None

    assert users.get_by_id(created.id) == created
    assert users.get_by_email("nobody@example.com") is None
    assert users.get_by_id("no-such-id") is None


def test_duplicate_email_raises(auth_env):
    users.create_user("nobu@example.com", "Nobu", "hash")
    with pytest.raises(users.EmailTakenError):
        users.create_user("nobu@example.com", "Different", "hash")


def test_duplicate_nickname_is_case_insensitive(auth_env):
    users.create_user("a@example.com", "Nobu", "hash")
    with pytest.raises(users.NicknameTakenError):
        users.create_user("b@example.com", "NOBU", "hash")
    with pytest.raises(users.NicknameTakenError):
        users.create_user("c@example.com", "nobu", "hash")


def test_touch_last_login(auth_env):
    created = users.create_user("nobu@example.com", "Nobu", "hash")
    users.touch_last_login(created.id)
    assert users.get_by_id(created.id).last_login_at is not None


def test_disabled_flag_round_trips(auth_env):
    created = users.create_user("nobu@example.com", "Nobu", "hash")
    import sqlite3
    with sqlite3.connect(users.DB_PATH) as conn:
        conn.execute("UPDATE users SET disabled = 1 WHERE id = ?", (created.id,))
    assert users.get_by_id(created.id).disabled is True
