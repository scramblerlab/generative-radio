"""The library endpoints were open to anyone who knew the public URL.

/api/library/index exposes the prompt, tags, seed, lyrics and DJ name of every
track ever generated, and is the index a client walks to bulk-download ~3 GB of
audio. These tests cover the gate and the ETag that keeps the payload cheap.
"""

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import auth as auth_module


@pytest.fixture
def lib(tmp_path):
    """A TrackLibrary rooted at tmp_path with two fake tracks."""
    import library
    tl = library.TrackLibrary(library_dir=str(tmp_path / "lib"),
                              api_audio_dir=str(tmp_path / "api"))
    tl.enabled = True
    tl.dir.mkdir(parents=True, exist_ok=True)
    for i, tid in enumerate(("aaa", "bbb")):
        (tl.dir / f"{tid}.mp3").write_bytes(b"audio")
        tl._index[tid] = {"trackId": tid, "createdAt": f"2026-01-0{i+1}", "lyrics": "la"}
    tl._index_version += 1
    return tl


def test_index_payload_is_valid_and_newest_first(lib):
    body, etag = lib.index_payload()
    data = json.loads(body)
    assert data["enabled"] is True
    assert data["count"] == 2
    assert [t["trackId"] for t in data["tracks"]] == ["bbb", "aaa"]
    assert etag.startswith('"') and etag.endswith('"')


def test_index_payload_is_cached_until_the_index_changes(lib):
    first_body, first_etag = lib.index_payload()
    assert lib.index_payload()[0] is first_body      # same object — not re-encoded

    lib._index["ccc"] = {"trackId": "ccc", "createdAt": "2026-01-09"}
    lib._index_version += 1
    second_body, second_etag = lib.index_payload()
    assert second_etag != first_etag
    assert json.loads(second_body)["count"] == 3


def test_eviction_changes_the_etag_even_though_the_count_matches(lib):
    """A cache keyed on len() alone would serve a stale payload here."""
    _, before = lib.index_payload()
    lib._index.pop("aaa")
    lib._index["ccc"] = {"trackId": "ccc", "createdAt": "2026-01-09"}
    lib._index_version += 1
    body, after = lib.index_payload()
    assert json.loads(body)["count"] == 2
    assert after != before


def test_get_meta_is_gone():
    """It had no call sites; removed rather than left as a second way in."""
    import library
    assert not hasattr(library.TrackLibrary, "get_meta")


# ---- the HTTP gate ---- #

@pytest.fixture
def client(auth_env, lib, monkeypatch):
    import main
    monkeypatch.setattr(main.radio, "library", lib)
    app = FastAPI()
    app.add_api_route("/api/library/index", main.get_library_index)
    app.add_api_route("/api/library/audio/{track_id}", main.get_library_audio)
    import ratelimit
    ratelimit.reset()
    return TestClient(app)


def bearer(nickname="Nobu"):
    user = auth_module.AuthUser(id="u1", email="a@b.co", nickname=nickname)
    token, _ = auth_module.create_access_token(user)
    return {"Authorization": f"Bearer {token}"}


def test_index_requires_a_member(client):
    assert client.get("/api/library/index").status_code == 401
    assert client.get("/api/library/index", headers=bearer()).status_code == 200


def test_audio_requires_a_member(client):
    assert client.get("/api/library/audio/aaa").status_code == 401
    res = client.get("/api/library/audio/aaa", headers=bearer())
    assert res.status_code == 200
    assert res.content == b"audio"


def test_unknown_track_is_404_not_a_path_escape(client):
    for bad in ("zzz", "..%2F..%2Fetc%2Fpasswd"):
        assert client.get(f"/api/library/audio/{bad}", headers=bearer()).status_code == 404


def test_index_returns_304_for_a_matching_etag(client):
    first = client.get("/api/library/index", headers=bearer())
    etag = first.headers["etag"]
    again = client.get("/api/library/index",
                       headers={**bearer(), "If-None-Match": etag})
    assert again.status_code == 304
    assert again.headers["etag"] == etag


def test_index_is_not_publicly_cacheable(client):
    """It is per-member data now, so a shared cache must not hold it."""
    res = client.get("/api/library/index", headers=bearer())
    assert "private" in res.headers["cache-control"]
    audio = client.get("/api/library/audio/aaa", headers=bearer())
    assert "private" in audio.headers["cache-control"]


def test_auth_enforce_off_reopens_the_endpoints(client, monkeypatch):
    monkeypatch.setenv("AUTH_ENFORCE", "0")
    assert client.get("/api/library/index").status_code == 200
