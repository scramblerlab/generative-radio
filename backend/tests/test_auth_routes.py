"""Endpoint tests for /api/auth/* — signup, login, logout, verify.

Covers the invite gate, the uniqueness rules, both transports (cookie and
bearer), and the rate limiter.
"""

import pytest

from conftest import TEST_INVITE

GOOD = {
    "email": "Nobu@Example.com ",     # deliberately unnormalized
    "password": "correcthorsebattery",
    "nickname": "  Nobu  ",           # deliberately unstripped
    "inviteCode": TEST_INVITE,
}


def signup(client, **overrides):
    return client.post("/api/auth/signup", json={**GOOD, **overrides})


# ---- signup ---- #

def test_signup_happy_path_normalizes_and_sets_cookie(client):
    res = signup(client)
    assert res.status_code == 201
    body = res.json()
    assert body["user"]["email"] == "nobu@example.com"   # stripped + lowercased
    assert body["user"]["nickname"] == "Nobu"            # stripped
    assert body["user"]["id"]
    assert body["expiresAt"]
    assert "token" not in body                          # browser transport
    assert "auth_token" in res.cookies


def test_signup_returns_token_only_for_bearer_transport(client):
    res = client.post("/api/auth/signup", json=GOOD,
                      headers={"X-Auth-Transport": "bearer"})
    assert res.status_code == 201
    assert res.json()["token"]


def test_signup_rejects_bad_invite_code(client):
    res = signup(client, inviteCode="WRONG")
    assert res.status_code == 403
    # and nothing was written
    assert client.post("/api/auth/login", json={
        "email": "nobu@example.com", "password": GOOD["password"]}).status_code == 401


def test_signup_rejects_duplicate_email(client):
    assert signup(client).status_code == 201
    res = signup(client, nickname="SomeoneElse")
    assert res.status_code == 409
    assert "email" in res.json()["detail"].lower()


def test_signup_rejects_duplicate_nickname_case_insensitively(client):
    assert signup(client).status_code == 201
    res = signup(client, email="other@example.com", nickname="NOBU")
    assert res.status_code == 409
    assert "nickname" in res.json()["detail"].lower()


@pytest.mark.parametrize("field,value", [
    ("email", "not-an-email"),
    ("email", "no@tld"),
    ("email", ""),
    ("password", "short"),          # 5 chars, min is 8
    ("password", "x" * 129),        # max is 128
    ("nickname", "a"),              # min is 2
    ("nickname", "x" * 25),         # max is 24
    ("nickname", "bad/slash"),
    ("nickname", "Auto"),           # reserved: the backend's auto-start pseudo-DJ
    ("nickname", "auto"),           # reserved check is case-insensitive
])
def test_signup_validation(client, field, value):
    assert signup(client, **{field: value}).status_code == 400


def test_signup_503_when_not_configured(client, monkeypatch):
    monkeypatch.delenv("JWT_SECRET")
    assert signup(client).status_code == 503


# ---- login / verify / logout ---- #

def test_login_cookie_lifecycle(client):
    signup(client)
    client.cookies.clear()

    assert client.post("/api/auth/verify").status_code == 401

    res = client.post("/api/auth/login", json={
        "email": "nobu@example.com", "password": GOOD["password"]})
    assert res.status_code == 200
    assert "auth_token" in res.cookies

    verified = client.post("/api/auth/verify")
    assert verified.status_code == 200
    assert verified.json()["user"]["nickname"] == "Nobu"

    assert client.post("/api/auth/logout").status_code == 200
    assert client.post("/api/auth/verify").status_code == 401


def test_login_bearer_lifecycle(client):
    signup(client)
    client.cookies.clear()

    res = client.post("/api/auth/login",
                      json={"email": "nobu@example.com", "password": GOOD["password"]},
                      headers={"X-Auth-Transport": "bearer"})
    token = res.json()["token"]
    client.cookies.clear()

    assert client.post("/api/auth/verify",
                       headers={"Authorization": f"Bearer {token}"}).status_code == 200
    assert client.post("/api/auth/verify",
                       headers={"Authorization": f"Bearer {token[:-1]}X"}).status_code == 401


def test_login_is_email_case_insensitive(client):
    signup(client)
    assert client.post("/api/auth/login", json={
        "email": "  NOBU@EXAMPLE.COM  ", "password": GOOD["password"]}).status_code == 200


def test_login_rejects_wrong_password(client):
    signup(client)
    assert client.post("/api/auth/login", json={
        "email": "nobu@example.com", "password": "wrong-password"}).status_code == 401


def test_login_rejects_unknown_account(client):
    assert client.post("/api/auth/login", json={
        "email": "nobody@example.com", "password": "whatever123"}).status_code == 401


def test_login_error_does_not_distinguish_unknown_from_wrong_password(client):
    """Both must be the same status and the same message, or the endpoint
    becomes an account-enumeration oracle."""
    signup(client)
    unknown = client.post("/api/auth/login", json={
        "email": "nobody@example.com", "password": "whatever123"})
    wrong = client.post("/api/auth/login", json={
        "email": "nobo@example.com", "password": "wrong-password"})
    assert unknown.status_code == wrong.status_code
    assert unknown.json()["detail"] == wrong.json()["detail"]


# ---- rate limiting ---- #

def test_login_rate_limited_per_ip(client):
    signup(client)
    codes = [client.post("/api/auth/login", json={
        "email": "nobu@example.com", "password": "wrong"}).status_code
        for _ in range(6)]
    assert codes[:5] == [401] * 5
    assert codes[5] == 429


def test_rate_limited_response_has_retry_after(client):
    signup(client)
    for _ in range(5):
        client.post("/api/auth/login", json={"email": "nobu@example.com", "password": "x"})
    res = client.post("/api/auth/login", json={"email": "nobu@example.com", "password": "x"})
    assert res.status_code == 429
    assert int(res.headers["retry-after"]) > 0


def test_signup_rate_limited_per_ip(client):
    """Protects the invite code from brute force."""
    codes = [signup(client, inviteCode="WRONG").status_code for _ in range(4)]
    assert codes == [403, 403, 403, 429]
