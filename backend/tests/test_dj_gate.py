"""Gate tests: who may claim the DJ slot, and where the DJ name comes from.

These exercise RadioOrchestrator directly rather than through a live socket.
Constructing one pulls in OllamaClient/ACEStepClient, but neither is contacted
unless a track is generated, and nothing here generates.
"""

import asyncio
import time

import pytest

import auth as auth_module
from conftest import TEST_SECRET


class FakeWS:
    """The subset of starlette's WebSocket that add_ws and the gates touch."""

    def __init__(self, ip="127.0.0.1", query=None, headers=None, cookies=None):
        self.client = type("C", (), {"host": ip})()
        self.query_params = query or {}
        self.headers = headers or {}
        self.cookies = cookies or {}
        self.sent: list = []

    async def send_json(self, payload):
        self.sent.append(payload)


@pytest.fixture
def radio(auth_env, monkeypatch):
    monkeypatch.setenv("WARMUP_ON_START", "0")
    from radio import RadioOrchestrator
    from llm import OllamaClient
    from acestep_client import ACEStepClient
    r = RadioOrchestrator(llm=OllamaClient(), acestep=ACEStepClient())
    # add_ws spawns broadcast tasks; swallow them so no event loop is needed.
    monkeypatch.setattr(r, "_send_to", lambda *a, **k: asyncio.sleep(0))
    monkeypatch.setattr(r, "broadcast", lambda *a, **k: asyncio.sleep(0))
    return r


def token_for(nickname="Nobu", user_id="u1"):
    user = auth_module.AuthUser(id=user_id, email=f"{nickname}@example.com", nickname=nickname)
    token, _ = auth_module.create_access_token(user)
    return user, token


def ack(sent):
    """The dj_claim_ack out of everything sent.

    A downgrade also pushes a fresh role_assigned from a background task, and
    which of the two lands first is up to the scheduler — so select by event.
    """
    acks = [m for m in sent if m.event == "dj_claim_ack"]
    assert acks, f"no dj_claim_ack in {[m.event for m in sent]}"
    return acks[-1].data


def connect(radio, ws, user=None, token=None):
    """add_ws without letting its fire-and-forget tasks run."""
    radio._ws_connections.append(ws)
    from netutil import is_local_ip, resolve_client_ip
    ip = resolve_client_ip(ws)
    radio._ws_meta[ws] = {
        "ip": ip, "connected_at": 0, "is_local": is_local_ip(ip),
        "user_id": user.id if user else None,
        "nickname": user.nickname if user else "",
        "auth_token": token,
        "legacy_mobile": ws.query_params.get("client") == "mobile" and not ws.query_params.get("v"),
    }


# ---- eligibility ---- #

def test_local_anonymous_client_is_not_dj_eligible(radio):
    """The old rule was `is_local or ?client=mobile`. Being on the LAN is no
    longer enough — this is the whole point of the change."""
    ws = FakeWS(ip="192.168.1.50")
    connect(radio, ws)
    assert radio._is_dj_eligible(ws) is False


def test_client_mobile_query_param_no_longer_grants_dj(radio):
    """Any browser could send this, which is why it is gone."""
    ws = FakeWS(ip="8.8.8.8", query={"client": "mobile"})
    connect(radio, ws)
    assert radio._is_dj_eligible(ws) is False


def test_signed_in_remote_client_is_dj_eligible(radio):
    user, token = token_for()
    ws = FakeWS(ip="8.8.8.8")
    connect(radio, ws, user, token)
    assert radio._is_dj_eligible(ws) is True


def test_auth_enforce_off_lets_everyone_through(radio, monkeypatch):
    monkeypatch.setenv("AUTH_ENFORCE", "0")
    ws = FakeWS(ip="8.8.8.8")
    connect(radio, ws)
    assert radio._is_dj_eligible(ws) is True


def test_controller_role_is_still_ip_based(radio):
    """Locked decision: signing out must not lock the host out of stop/skip."""
    local, remote = FakeWS(ip="127.0.0.1"), FakeWS(ip="8.8.8.8")
    connect(radio, local)
    connect(radio, remote)
    assert radio._ws_meta[local]["is_local"] is True
    assert radio._ws_meta[remote]["is_local"] is False


# ---- role_assigned ---- #

def test_role_assigned_always_carries_dj_availability(radio):
    """_promote_next_controller used to omit djAvailable, so a promoted local
    viewer silently lost the DJ button. One builder now feeds every sender."""
    user, token = token_for()
    ws = FakeWS()
    connect(radio, ws, user, token)
    for role in ("controller", "viewer"):
        data = radio._role_assigned_message(ws, role).data
        assert data["role"] == role
        assert data["djAvailable"] is True
        assert data["nickname"] == "Nobu"


def test_role_assigned_for_anonymous(radio):
    ws = FakeWS()
    connect(radio, ws)
    data = radio._role_assigned_message(ws, "viewer").data
    assert data["djAvailable"] is False
    assert data["nickname"] == ""


# ---- claim ---- #

def test_claim_rejected_with_auth_required(radio):
    ws = FakeWS()
    connect(radio, ws)
    sent = []
    radio._send_to = lambda w, m: sent.append(m) or asyncio.sleep(0)
    asyncio.run(radio.claim_dj_from_ws(ws))
    assert ack(sent) == {"granted": False, "reason": "auth_required"}
    assert radio._dj_claimant_ws is None


def test_claim_granted_when_signed_in(radio):
    user, token = token_for()
    ws = FakeWS()
    connect(radio, ws, user, token)
    radio._dj_lock_until = 0
    sent = []
    radio._send_to = lambda w, m: sent.append(m) or asyncio.sleep(0)
    asyncio.run(radio.claim_dj_from_ws(ws))
    assert ack(sent)["granted"] is True
    assert radio._dj_claimant_ws is ws


def test_second_claimant_is_told_locked_not_auth(radio):
    """The two refusals need different remedies, so they must be distinguishable."""
    (u1, t1), (u2, t2) = token_for("A", "u1"), token_for("B", "u2")
    first, second = FakeWS(), FakeWS()
    connect(radio, first, u1, t1)
    connect(radio, second, u2, t2)
    radio._dj_lock_until = 0
    sent = []
    radio._send_to = lambda w, m: sent.append(m) or asyncio.sleep(0)
    asyncio.run(radio.claim_dj_from_ws(first))
    asyncio.run(radio.claim_dj_from_ws(second))
    assert ack(sent) == {"granted": False, "reason": "locked"}


def test_expired_token_downgrades_the_connection(radio, monkeypatch):
    user, token = token_for()
    ws = FakeWS()
    connect(radio, ws, user, token)
    # Same secret, already-expired token: signature valid, exp is not.
    import jwt
    from datetime import datetime, timedelta, timezone
    radio._ws_meta[ws]["auth_token"] = jwt.encode(
        {"sub": "u1", "nick": "Nobu", "exp": datetime.now(timezone.utc) - timedelta(days=1)},
        TEST_SECRET, algorithm="HS256")
    radio._dj_lock_until = 0
    sent = []
    radio._send_to = lambda w, m: sent.append(m) or asyncio.sleep(0)
    asyncio.run(radio.claim_dj_from_ws(ws))
    assert ack(sent)["reason"] == "auth_required"
    assert radio._ws_meta[ws]["user_id"] is None      # downgraded, not just refused
    assert radio._ws_meta[ws]["nickname"] == ""


# ---- the impersonation fix ---- #

def test_dj_name_comes_from_the_session_not_the_payload(radio):
    """dj_submit used to take djName straight from the client and broadcast it,
    stamping it into every generated track's permanent library sidecar."""
    user, token = token_for("Nobu")
    ws = FakeWS()
    connect(radio, ws, user, token)
    radio._dj_claimant_ws = ws
    rescheduled = []
    radio.reschedule = lambda *a, **k: rescheduled.append(a) or asyncio.sleep(0)
    radio._send_to = lambda *a, **k: asyncio.sleep(0)

    asyncio.run(radio.submit_dj_from_ws(ws, ["rock"], [], "en", ""))

    assert radio._dj_name == "Nobu"
    assert len(rescheduled) == 1


def test_submit_dj_signature_has_no_dj_name_parameter():
    """Guards against the field being reintroduced as a convenience."""
    import inspect
    from radio import RadioOrchestrator
    params = inspect.signature(RadioOrchestrator.submit_dj_from_ws).parameters
    assert "dj_name" not in params


def test_submit_with_expired_session_releases_the_slot(radio):
    """Otherwise the DJ slot stays held until the lock times out."""
    user, token = token_for()
    ws = FakeWS()
    connect(radio, ws, user, token)
    radio._ws_meta[ws]["auth_token"] = "garbage"
    radio._dj_claimant_ws = ws
    radio._dj_lock_until = 9e18
    sent = []
    radio._send_to = lambda w, m: sent.append(m) or asyncio.sleep(0)

    asyncio.run(radio.submit_dj_from_ws(ws, ["rock"], [], "en", ""))

    assert ack(sent)["reason"] == "session_expired"
    assert radio._dj_claimant_ws is None
    assert radio._dj_lock_until < 9e18       # released for the next person


def test_signed_in_controller_nickname_overrides_typed_start_name(radio):
    """start_from_ws keeps its free-text name for a logged-out local host, but an
    authenticated identity must not be overridable from the same client."""
    user, token = token_for("Nobu")
    ws = FakeWS()
    connect(radio, ws, user, token)
    radio._controller_ws = ws
    radio.start = lambda *a, **k: asyncio.sleep(0)
    radio._send_to = lambda *a, **k: asyncio.sleep(0)

    asyncio.run(radio.start_from_ws(ws, ["rock"], [], "en", "", None, "IMPOSTOR"))
    assert radio._dj_name == "Nobu"


def test_logged_out_controller_keeps_the_typed_name(radio):
    ws = FakeWS()
    connect(radio, ws)
    radio._controller_ws = ws
    radio.start = lambda *a, **k: asyncio.sleep(0)
    radio._send_to = lambda *a, **k: asyncio.sleep(0)

    asyncio.run(radio.start_from_ws(ws, ["rock"], [], "en", "", None, "Local Host"))
    assert radio._dj_name == "Local Host"


# ---- releasing the slot ---- #

def test_disconnecting_claimant_releases_the_lock(radio):
    """A claimant that drops without submitting frees the slot immediately.

    remove_ws used to clear _dj_claimant_ws but leave _dj_lock_until at
    claim-time + _DJ_LOCK_S, so for the whole cooldown nobody could claim even
    though nobody was DJing. cancel_dj_claim_from_ws always released both; a
    dropped connection is the same situation and now gets the same treatment.
    """
    (u1, t1), (u2, t2) = token_for("A", "u1"), token_for("B", "u2")
    first, second = FakeWS(), FakeWS()
    connect(radio, first, u1, t1)
    connect(radio, second, u2, t2)
    radio._dj_lock_until = 0
    sent = []
    radio._send_to = lambda w, m: sent.append(m) or asyncio.sleep(0)

    async def scenario():
        await radio.claim_dj_from_ws(first)
        assert radio._dj_lock_until > time.time()      # claim re-locks for others
        radio.remove_ws(first)                         # drops without submitting
        sent.clear()
        await radio.claim_dj_from_ws(second)

    asyncio.run(scenario())
    assert ack(sent)["granted"] is True
    assert radio._dj_claimant_ws is second


def test_disconnect_by_a_non_claimant_keeps_the_cooldown(radio):
    """The release is scoped to a pending claim.

    submit_dj_from_ws clears _dj_claimant_ws and deliberately leaves the lock
    running — that cooldown is what spaces DJ sessions apart. So a disconnect
    while no claim is pending must not shorten it.
    """
    user, token = token_for()
    ws = FakeWS()
    connect(radio, ws, user, token)
    radio._dj_claimant_ws = None                       # as it is after a submit
    locked_until = time.time() + 120
    radio._dj_lock_until = locked_until

    async def scenario():
        radio.remove_ws(ws)

    asyncio.run(scenario())
    assert radio._dj_lock_until == locked_until
