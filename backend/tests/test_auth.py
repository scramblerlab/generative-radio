"""Unit tests for password hashing and session tokens.

These two things are the reason this project has tests at all: a silent bug in
either is invisible to manual testing and catastrophic in production. The rest
of the pipeline (LLM → ACE-Step → audio) is verified by hand.
"""

import os
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi import HTTPException

import auth as auth_module
from conftest import TEST_SECRET


# ---- password hashing ---- #

def test_hash_verify_roundtrip(auth_env):
    stored = auth_module.hash_password("correcthorsebatterystaple")
    assert auth_module.verify_password("correcthorsebatterystaple", stored)


def test_verify_rejects_wrong_password(auth_env):
    stored = auth_module.hash_password("correcthorsebatterystaple")
    assert not auth_module.verify_password("correcthorsebatterystaplf", stored)
    assert not auth_module.verify_password("", stored)


def test_hash_is_salted(auth_env):
    """Two hashes of the same password must differ, or the salt is not working."""
    a = auth_module.hash_password("same-password")
    b = auth_module.hash_password("same-password")
    assert a != b
    assert auth_module.verify_password("same-password", a)
    assert auth_module.verify_password("same-password", b)


def test_hash_format(auth_env):
    stored = auth_module.hash_password("whatever")
    scheme, n, r, p, salt, key = stored.split("$")
    assert scheme == "scrypt"
    assert (int(n), int(r), int(p)) == (2 ** 15, 8, 1)
    assert salt and key


def test_verify_survives_malformed_hash(auth_env):
    for junk in ("", "not-a-hash", "scrypt$1$2$3", "bcrypt$1$2$3$4$5", "scrypt$x$8$1$aa$bb"):
        assert not auth_module.verify_password("anything", junk)


def test_verify_reads_cost_params_from_the_hash(auth_env):
    """A hash written with weaker parameters must still verify, so the cost
    factors can be raised later without invalidating existing accounts."""
    import base64, hashlib, secrets
    salt = secrets.token_bytes(16)
    key = hashlib.scrypt(b"legacy", salt=salt, n=1024, r=8, p=1, dklen=32)
    b64 = lambda raw: base64.urlsafe_b64encode(raw).decode().rstrip("=")
    stored = f"scrypt$1024$8$1${b64(salt)}${b64(key)}"
    assert auth_module.verify_password("legacy", stored)
    assert not auth_module.verify_password("wrong", stored)


# ---- tokens ---- #

USER = auth_module.AuthUser(id="abc123", email="nobu@example.com", nickname="Nobu")


def test_token_roundtrip(auth_env):
    token, exp = auth_module.create_access_token(USER)
    decoded = auth_module.verify_token(token)
    assert decoded == USER
    assert exp > datetime.now(timezone.utc)


def test_token_rejects_tampered_signature(auth_env):
    token, _ = auth_module.create_access_token(USER)
    tampered = token[:-1] + ("A" if token[-1] != "A" else "B")
    with pytest.raises(HTTPException) as e:
        auth_module.verify_token(tampered)
    assert e.value.status_code == 401


def test_token_rejects_alg_none(auth_env):
    """The classic JWT bypass: re-sign the payload with alg=none."""
    forged = jwt.encode({"sub": "abc123", "nick": "Nobu",
                         "exp": datetime.now(timezone.utc) + timedelta(days=1)},
                        key="", algorithm="none")
    with pytest.raises(HTTPException):
        auth_module.verify_token(forged)


def test_token_rejects_foreign_algorithm(auth_env):
    """A token signed HS512 with the same secret must not be accepted."""
    forged = jwt.encode({"sub": "abc123", "nick": "Nobu",
                         "exp": datetime.now(timezone.utc) + timedelta(days=1)},
                        TEST_SECRET, algorithm="HS512")
    with pytest.raises(HTTPException):
        auth_module.verify_token(forged)


def test_token_rejects_wrong_secret(auth_env):
    forged = jwt.encode({"sub": "abc123", "nick": "Nobu",
                         "exp": datetime.now(timezone.utc) + timedelta(days=1)},
                        "a-different-secret", algorithm="HS256")
    with pytest.raises(HTTPException):
        auth_module.verify_token(forged)


def test_token_rejects_expired(auth_env):
    expired = jwt.encode({"sub": "abc123", "nick": "Nobu",
                          "exp": datetime.now(timezone.utc) - timedelta(hours=1)},
                         TEST_SECRET, algorithm="HS256")
    with pytest.raises(HTTPException) as e:
        auth_module.verify_token(expired)
    assert e.value.status_code == 401


def test_token_rejects_missing_claims(auth_env):
    for payload in ({"nick": "Nobu"}, {"sub": "abc123"}, {"sub": "", "nick": "Nobu"}):
        payload = {**payload, "exp": datetime.now(timezone.utc) + timedelta(days=1)}
        forged = jwt.encode(payload, TEST_SECRET, algorithm="HS256")
        with pytest.raises(HTTPException):
            auth_module.verify_token(forged)


def test_token_rejected_when_secret_unset(auth_env, monkeypatch):
    token, _ = auth_module.create_access_token(USER)
    monkeypatch.delenv("JWT_SECRET")
    with pytest.raises(HTTPException) as e:
        auth_module.verify_token(token)
    assert e.value.status_code == 401


# ---- transport extraction ---- #

class _FakeHTTP:
    def __init__(self, headers=None, cookies=None):
        self.headers = headers or {}
        self.cookies = cookies or {}


class _FakeWS(_FakeHTTP):
    def __init__(self, headers=None, cookies=None, query=None):
        super().__init__(headers, cookies)
        self.query_params = query or {}


def test_extract_http_prefers_header_over_cookie():
    req = _FakeHTTP(headers={"authorization": "Bearer from-header"},
                    cookies={"auth_token": "from-cookie"})
    assert auth_module.extract_token_http(req) == "from-header"


def test_extract_http_falls_back_to_cookie():
    assert auth_module.extract_token_http(
        _FakeHTTP(cookies={"auth_token": "from-cookie"})) == "from-cookie"
    assert auth_module.extract_token_http(_FakeHTTP()) is None


def test_extract_http_ignores_non_bearer_schemes():
    req = _FakeHTTP(headers={"authorization": "Basic abc"}, cookies={"auth_token": "ck"})
    assert auth_module.extract_token_http(req) == "ck"


def test_extract_ws_precedence():
    """Header, then cookie, then ?token= — React Native can only use the last."""
    assert auth_module.extract_token_ws(_FakeWS(
        headers={"authorization": "Bearer h"},
        cookies={"auth_token": "c"}, query={"token": "q"})) == "h"
    assert auth_module.extract_token_ws(_FakeWS(
        cookies={"auth_token": "c"}, query={"token": "q"})) == "c"
    assert auth_module.extract_token_ws(_FakeWS(query={"token": "q"})) == "q"
    assert auth_module.extract_token_ws(_FakeWS()) is None
