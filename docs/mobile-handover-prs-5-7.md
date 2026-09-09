# Handover — mobile work (PRs 5–7)

**Audience:** the Claude session running on the mobile-dev MacBook.
**Written:** 2026-09-09, immediately after PR 4 merged.
**Status:** all backend and web work is **done and merged**. Everything left is in `mobile/`.

Read this first, then `docs/member-auth-and-offline-gating-plan.md` (the full plan; §E is the offline bug catalogue with file/line references, and the per-PR human test checklists live at the end).

---

## 0. How the user wants this run

Strictly **one PR at a time**: implement → you run automated checks → **the user manually tests on a device** → they merge → only then start the next PR. Never open two PRs. Never start the next before the current is merged.

Each PR ends with an explicit checkbox list for the user to click through. The lists are already written in the plan doc; adapt them if the implementation diverges.

The user reads Japanese. Previous sessions replied in Japanese with code, identifiers and commit messages in English. Commit messages and PR bodies are in English.

Use the `ship-pr` skill for the PR lifecycle. The repo's default branch is `main`.

---

## 1. What already shipped (do not redo)

| PR | What landed |
|---|---|
| #99 | Web wired to `@radio/shared`; the duplicate `frontend/src/types.ts` deleted. **Add shared types once, both apps see them.** |
| #100 | `backend/{users,auth,ratelimit,netutil}.py`, `backend/routers/auth.py`. Accounts, invite-gated signup, scrypt + HS256. |
| #101 | Web sign-in/sign-up UI, `packages/shared/src/{auth,validation,authClient}.ts`. |
| `feat/dj-requires-login` | **DJ and library gates are now live.** See §2. |

Backend and web are finished. If you find yourself editing `backend/` or `frontend/`, stop and check whether it really belongs to the mobile work.

---

## 2. What the server now expects from mobile

This is the contract you are implementing against. It is already deployed.

### Authentication

Two transports, one identity. Mobile uses the **bearer** one:

- `POST /api/auth/{signup,login,logout,verify}`
- Send `X-Auth-Transport: bearer` to get a `token` in the response body. Without that header the server only sets a cookie, which React Native cannot reliably keep.
- Send `Authorization: Bearer <token>` on every authenticated REST call.
- **WebSocket:** append `?token=<jwt>`. Browsers send a cookie on the upgrade; RN cannot, so the query param is the mobile path. Both start scripts now run uvicorn with `--no-access-log` so tokens do not land in logs.

`packages/shared/src/authClient.ts` already implements all of this. Construct it with `baseUrl: BACKEND_URL` and a `getToken` that reads SecureStore — passing `getToken` is what switches it to bearer mode. **Do not write a second auth client.**

Validation rules live in `packages/shared/src/validation.ts` and are kept byte-compatible with the Python in `backend/routers/auth.py`. Use them; do not re-derive.

### The DJ gate

- `?client=mobile` **no longer grants anything.** It is read only to detect pre-account builds and send them a one-time "update the app" `error` event. New builds must send `?v=1.6.0` (any non-empty `v`) to suppress that notice.
- `role_assigned` now carries `{ role, djAvailable, nickname }`. `djAvailable` is true iff the connection is authenticated. **`mobile/src/hooks/useRadio.ts` has no `role_assigned` handler at all** — grep confirms zero matches. You must add one; today the mobile DJ button is shown unconditionally and only the server stops it.
- `dj_claim_ack` now carries `{ granted, reason? }` where reason is `'auth_required' | 'locked' | 'session_expired'`. Open the login modal for the auth reasons; `'locked'` is already explained by the on-screen countdown.
- **`dj_submit` no longer accepts `djName`.** The server takes the name from the authenticated session. Mobile still sends it; the server ignores it. Remove the field and the input.

### The library gate

`GET /api/library/index` and `GET /api/library/audio/{id}` now require a member. Anonymous callers get **401**.

- `fetchLibraryIndex` (`mobile/src/utils/offlineLibrary.ts:54`) needs an `Authorization` header.
- The per-file download (`offlineLibrary.ts:169`) needs one too. `expo-file-system`'s `DownloadOptions` supports `headers` — verified at `node_modules/expo-file-system/build/ExpoFileSystem.types.d.ts:141-147`.
- Handle `401` distinctly from a network failure. "Library unavailable — check connection" is wrong and misleading when the real problem is an expired session.
- `/api/library/index` now returns an `ETag` and `Cache-Control: private, max-age=60`. Sending `If-None-Match` gets a `304` and saves ~1.2 MB per panel open. Worth doing.

---

## 3. The three PRs, in order

### PR 5 — `fix/mobile-offline-player-teardown` (do this first; it is small)

The user-reported bug: **online and offline audio play at the same time.**

There is only one `playerRef`, so this is not two player instances. The cause is that **`expo-audio`'s `AudioPlayer.remove()` does not stop playback** — the native implementations only drop the object from the module registry:

```swift
// node_modules/expo-audio/ios/AudioModule.swift:251
Function("remove") { player in self.registry.remove(player) }   // that is all it does
// same file :244 — pause() is the only thing that calls ref.pause()
```
Android is identical (`AudioModule.kt:494`).

`playOfflineTrack` (`mobile/src/hooks/useRadio.ts:517`) is the one teardown site that calls `remove()` without `pause()` first, then starts the offline player — so the online one keeps decoding `documents/track_current.mp3`. This is why the bug is **directional**: offline→online is clean, because `exitOfflineMode` (:1238) and `tuneOut` (:1192) do pause first.

`docs/offline-mode-plan.md:440-441` prescribed the buggy sequence, so this was designed in, not a slip.

**Fix:** extract one `teardownPlayer()` (`clearLockScreenControls()` → `pause()` → `remove()` → null the ref, each in its own try/catch, and null the ref *first* so a re-entrant call cannot double-tear-down). Apply at all four sites: `:517`, `:723` (the online path — latent there, and reachable via the WS `play_now` interrupt at :960 and the `playbackState === 'failed'` recovery at :341), `:1192`, `:1238`.

Also fix the early return at `:515`: `if (!playerReadyRef.current) return;` fires *before* the old player is touched, so `enterOfflineMode` can finish with the banner up and the online track still audible. Move the readiness check into `enterOfflineMode` before it mutates any state.

`AudioPlayer` extends `SharedObject`, so `release()` exists at runtime and would force deterministic native teardown — but it makes every later call throw and interacts badly with the status-listener lifecycle. `pause()` is the correct, sufficient fix. Leave a TODO, do not use `release()` here.

Ship this alone. It is the bug the user actually reported and it should not wait behind anything.

### PR 6 — `fix/mobile-offline-integrity-and-ux`

The P1 and P2 items from plan §E.2 and §E.3, merged into one PR so the user tests once. The worst is:

> `offlineLibrary.ts:156-164` calls `clearOfflineTracks()` **before the first byte is downloaded**, so a network failure on file 1 destroys the user's entire existing library.

Fix with a staging directory and swap-on-success, which also removes the need for the disk-space precheck to reason about space it is about to free. Write an `offline/manifest.json` at swap time while you are there — it kills the synchronous 500-sidecar scan on the JS thread (`:84-101`).

The rest — the `existingCount` staleness, the overloaded `indexError`, the sidecar write outside the try/catch, delete-before-retry, the `dropOfflineTrack` index bug, the iOS background `duration` fallback, the `exitOfflineMode` reachability check, `enterOfflineMode` idempotency, persisting offline mode across restarts — is enumerated with file/line references in plan §E. Work through it there; do not re-derive the list.

### PR 7 — `feat/mobile-auth-ui`

- Add `expo-secure-store` (**new native module → full rebuild, and this is the PR that goes to the stores**).
- `mobile/src/hooks/useAuth.ts` — plain hook, no Context needed: `mobile/src/App.tsx` is 36 lines and already threads `radio` into `AppNavigator`. Hydrates asynchronously from SecureStore, unlike web which hydrates from a `verify` round trip — which is exactly why the two auth containers are not shared.
- `mobile/src/components/AuthModal.tsx` — clone the structure of `OfflinePanel.tsx` (the closest existing modal-with-a-form) and use `mobile/src/components/theme.ts` tokens. **Never invent new styling** — this is a standing instruction from the user.
- `mobile/src/config.ts`: `WS_URL` is currently a module-level constant string; it must become `wsUrl(token)`. Drop `?client=mobile`, add `?v=<version>` and `?token=`.
- Add the `role_assigned` handler to `mobile/src/hooks/useRadio.ts` (it has none).
- Gate the DJ and Offline buttons on `isAuthenticated` in `AppNavigator.tsx` (`onClaimDj` at :56, `onOpenOfflinePanel` at :61).
- Remove `djName` from `mobile/src/components/DJPanel.tsx` (state at :35, guard at :106, submit at :113, the input at :227-237) and from `useRadio.ts` (:65, :1271, :1274). Show "DJ: {nickname}" read-only, as the web panel now does.
- Bump `mobile/app.json` to 1.6.0 / build 6.
- **Log out while in offline mode:** allow it, keep playing, and **do not delete downloaded files** — they were authorized when downloaded, and deleting a file mid-playback is the same class of bug as PR 5. On exit, land in anonymous online mode with the DJ and Offline buttons simply absent. Not an error state.

---

## 4. Things that will bite you

- **You can build; the previous machine could not.** Sessions before this one could only run `tsc --noEmit` (no CocoaPods, no adb, no Java, no `mobile/ios/`). So *nothing in `mobile/` has ever been run since the offline feature was written* — treat the existing offline code as unverified, not as working code with a couple of bugs.
- **`mobile/ios/` does not exist in the repo.** You will need to generate it (`expo prebuild`) or run through Expo's managed flow. `mobile/android/` does exist and there is a local Expo module at `mobile/modules/background-http/` plus a config plugin at `mobile/plugins/withBackgroundDownloader.js` — a bare `expo prebuild --clean` could clobber Android customizations. Check before running it.
- **Expo SDK 55 is a canary build** (`55.0.10-canary-20260328-bdc6273`). Pinned deliberately. Do not upgrade it as a side effect.
- **Two separate download systems, deliberately.** The online path uses `@kesha-antonov/react-native-background-downloader` writing to a fixed `documents/track_current.mp3`; offline uses `expo-file-system` under `Paths.document/offline/tracks/`. They never collide. Keep it that way.
- **The backend is on the other machine.** `radio.scrambler-lab.com` points at the user's Mac Studio via Cloudflare Tunnel. Set `BACKEND_URL`/`wsUrl` to the tunnel, not localhost, unless they are also running the backend locally. `__DEV__` currently picks `localhost:5555`, which will be wrong on the mobile machine.
- **Testing needs an account.** Signup is invite-gated; the invite code is in `~/.generative-radio.env` **on the backend machine**, not on the mobile one. Ask the user for it.
- **A deleted account keeps working for up to 30 days.** `get_current_user` is claims-only with no DB lookup, because one offline download is up to 500 authenticated requests. So do not test "revoked user" by deleting a DB row — it will still pass. Accepted tradeoff, documented in `README.md`.
- **`AUTH_ENFORCE=0`** on the backend disables both gates without a redeploy. Useful if you need to isolate whether a mobile failure is auth-related. It is a rollback switch, not a mode to develop against.
- **Python's `is_private` counts the RFC 5737 documentation ranges** (`203.0.113.x` and friends) as local. If you write a backend test with a "remote" IP, use `8.8.8.8`. Noted in `backend/netutil.py`.

---

## 5. Verifying the server side from the mobile machine

```bash
BASE=https://radio.scrambler-lab.com
TOKEN=$(curl -s $BASE/api/auth/login -H 'Content-Type: application/json' \
  -H 'X-Auth-Transport: bearer' \
  -d '{"email":"...","password":"..."}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/library/index                        # 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" $BASE/api/library/index  # 200
```

WebSocket (`pip install websockets`), confirming what mobile must reproduce:

```python
import asyncio, json, websockets
async def probe(url):
    async with websockets.connect(url) as ws:
        for _ in range(4):
            m = json.loads(await ws.recv())
            if m["event"] == "role_assigned":
                return m["data"]
# no token          -> djAvailable False
# ?token=<jwt>      -> djAvailable True, nickname set
```

Note `curl -I` gets **405** on these routes — they are GET-only and Starlette does not auto-add HEAD here. Use `curl -D -` if you want headers.

---

## 6. State of the world

- Backend: `main` includes `feat/dj-requires-login`. Tests: `cd backend && .venv/bin/python -m pytest tests -q` → 75 passing.
- Web: complete. Sign in, sign up, sign out, DJ requires login, DJ name is the nickname.
- Mobile: **untouched by the auth work.** It still sends `?client=mobile` and a free-text `djName`, both now ignored by the server. So on current `main`, **the installed mobile app has lost DJ mode and offline downloads.** The user has explicitly accepted this; PR 7 restores them.
