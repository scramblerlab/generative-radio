# Radio 会員ログイン機能 + DJ/オフライン会員限定化 実装プラン

## Context（背景と目的）

現在の Radio プロジェクトには**ユーザーという概念が一切存在しない**。認証も DB もなく、権限判定は接続元 IP と WebSocket のクエリパラメータだけで行われている。これが3つの問題を生んでいる。

1. **DJ 機能の開放条件が脆い。** `?client=mobile` を付けて WebSocket に繋ぐだけで誰でも DJ 権限を取得できる（[mobile/src/config.ts](mobile/src/config.ts) の仕様がそのまま公開 URL に通用してしまう）。さらに DJ 名は毎回フリーテキスト入力で、なりすましが自由。
2. **オフライン再生機能にバグがある。** 特に「オンライン再生とオフライン再生が同時に鳴る」問題が実在する（根本原因は §E.1 で特定済み）。加えてダウンロード失敗時に既存ライブラリを全消失する等、データ損失系のバグが複数ある。
3. **`/api/library/*` が完全無認証。** 公開 URL を知っていれば誰でも全 500 曲のプロンプト・歌詞・シードをスクレイプでき、約 3GB の MP3 を一括ダウンロードできる。

これらを、Logger プロジェクトと同型の**会員ログイン機能**を導入して一気に解決する。ログイン時にニックネームを必須化し、それを DJ 名として使う。DJ 機能とオフライン再生を会員限定にする。

**確定した方針（ユーザー決定済み）**

| 項目 | 決定 |
|---|---|
| 会員登録 | **招待コード制**（環境変数のコードを知る人のみ登録可） |
| ニックネーム | **登録時必須**。DJ 名として使用（フリーテキスト入力は廃止） |
| DJ 機能 | **全クライアントでログイン必須**（ローカル IP でも要ログイン） |
| controller 権限 | **ローカル IP のまま変更しない**（start/stop/skip/advanced options） |
| オフライン再生 | **モバイル限定 かつ ログイン必須**。Web には作らない |
| パスワードリセット / メール確認 | **スコープ外** |

---

## 前提となるアーキテクチャの事実（調査で確定）

- **Web は本番でも同一オリジン。** Cloudflare Tunnel `radio.scrambler-lab.com` → Vite preview :5173 → `preview.proxy` が `/api`・`/ws` を :5555 にプロキシ（[frontend/vite.config.ts](frontend/vite.config.ts#L60-L69)、[docs/cloudflare-named-tunnel-setup.md](docs/cloudflare-named-tunnel-setup.md#L78-L81)）。**httpOnly Cookie が Logger と全く同じ形で使える。CORS は Web に対しては無関係。**
- **モバイルは Cookie が使えない** → Bearer トークン。両方を1つの Depends で受ける設計にする。
- **DB が存在しない。** SQLAlchemy も Alembic も sqlite3 も未使用。会員機能で初めて永続ストアが要る。
- **`APIRouter` も `Depends()` も1つも存在しない。** [backend/main.py](backend/main.py) に全エンドポイントがベタ書き。
- **テストが1つも無い**（pytest / vitest / jest / CI 全て無し）。
- **`python-dotenv` は既に .venv に入っている**（uvicorn[standard] の推移依存）。Python は 3.14.5 で `hashlib.scrypt` が使える。
- **`packages/shared` は型定義のみでモバイル専用。** Web は [frontend/src/types.ts](frontend/src/types.ts) に fork を持っており既に乖離している（`replay?: boolean` が Web 側にしかない）。

---

## A. バックエンド認証モジュール

### A.1 新規ファイル

```
backend/users.py            # sqlite3 ストア（スキーマ, create_user, get_by_email）
backend/auth.py             # ハッシュ / トークン / AuthUser / FastAPI 依存関数
backend/ratelimit.py        # インプロセスのスライディングウィンドウ制限
backend/netutil.py          # _normalize_ip / _is_local_ip / _resolve_request_ip を main.py から移設
backend/routers/auth.py     # APIRouter（このリポジトリ初）
backend/users.db            # 実行時生成物 → .gitignore に追加
```

**`APIRouter` を導入する理由**は意図的なテスタビリティのため。[backend/main.py](backend/main.py#L35-L41) は import 時に `OllamaClient` / `ACEStepClient` / `RadioOrchestrator` を生成するので、テストで `from main import app` すると Ollama に接続しにいく。独立したルーターなら素の `FastAPI()` にマウントしてテストできる。`main.py` への追加は `app.include_router(auth_router)` の1行だけ。

`_resolve_request_ip` を `netutil.py` に移すのは、ルーターが `main` を import せずにレート制限のキーとして使えるようにするため（Tunnel 経由では `request.client.host` が常に 127.0.0.1 なので必須）。

### A.2 依存パッケージ

`requirements.txt` に追加するのは**2行だけ**：

```
python-dotenv>=1.0.0
PyJWT>=2.10
```

- **パスワードハッシュは stdlib の `hashlib.scrypt`**（n=2^15, r=8, p=1, salt 16B, key 32B）。bcrypt / passlib を足す必要はない。保存形式 `scrypt$16384$8$1$<salt_b64>$<key_b64>`。**約 100ms かかるので必ず `asyncio.to_thread` で実行する** — イベントループは全リスナーへの WS ブロードキャストを回しているため。
- **JWT は PyJWT**（HS256 のみなら純 Python、`[crypto]` extra 不要）。Logger が使う `python-jose` は古く推移依存の `ecdsa` に既知のサイドチャネルがあるので**採用しない**。デコードは `algorithms=["HS256"]` を必ず明示。
- **レート制限は自前 30 行**。slowapi は推移依存を2つ引くうえ、uvicorn がシングルプロセス（両 start スクリプトとも `--workers` 無し）なのでインメモリで厳密に動く。

### A.3 スキーマ（[backend/users.py](backend/users.py)）

```sql
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,           -- uuid4 hex
  email         TEXT NOT NULL,              -- strip().lower() で保存
  nickname      TEXT NOT NULL,              -- DJ 表示名
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,              -- ISO-8601 UTC
  last_login_at TEXT,
  disabled      INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email    ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname ON users(lower(nickname));
```

**ニックネームは大文字小文字を無視して一意にする。** ニックネームは `dj_state.activeDjName` として全リスナーにブロードキャストされ、`TrackInfo.dj_name` → ライブラリのサイドカーに焼き込まれる（[backend/radio.py](backend/radio.py#L1097)）ため、重複を許すとなりすましが成立する。

接続はグローバルに持たず、操作ごとに `sqlite3.connect(DB_PATH, timeout=5)` を `asyncio.to_thread` の中で開く。初期化時に一度だけ `PRAGMA journal_mode=WAL`。認証トラフィックは1日数リクエストなので正しさを優先。

### A.4 エンドポイント（prefix `/api/auth`）

Cookie（ブラウザ用）と `token` フィールド（モバイル用）の両方を返す。ただし `token` は**リクエストが `X-Auth-Transport: bearer` を送ってきた時だけ**含める（ブラウザに保存すべきでないトークンを渡さないため）。

| Method | Path | Request | 成功 | エラー |
|---|---|---|---|---|
| POST | `/signup` | `{email, password, nickname, inviteCode}` | `201 {user:{id,email,nickname}, expiresAt, token?}` + Cookie | `400` 検証, `403` 招待コード不正, `409` email/nickname 重複, `429`, `503` 未設定 |
| POST | `/login` | `{email, password}` | `200 {user, expiresAt, token?}` + Cookie | `401`, `403` 無効化済み, `429`, `503` |
| POST | `/logout` | — | `200 {ok:true}` + Cookie 削除 | — |
| POST | `/verify` | Cookie か Bearer | `200 {valid:true, user:{...}}` | `401` |

`/verify` が Logger と同じくセッション復元（`/me` 相当）を兼ねる。

**検証ルール**（TS 側と厳密に一致させる、§D 参照）
- email: `strip().lower()`, 254 文字以下, `^[^@\s]+@[^@\s]+\.[^@\s]+$`
- password: 8〜128 文字（構成ルール無し。長さのほうが有効）
- nickname: 2〜24 文字, `^[\w \-.]+$`（Unicode 対応）, `strip()`。**予約語 `Auto` と空文字を拒否** — [backend/radio.py](backend/radio.py#L209) が自動開始時の擬似 DJ 名に `"Auto"` を使っているため。

招待コードの照合は `hmac.compare_digest` で、**DB アクセスより先に**行う（このエンドポイントを招待コードのオラクルにしないため）。

**Cookie パラメータ**（Logger を踏襲、2点だけ変更）:

```python
response.set_cookie(
    key="auth_token", value=token, httponly=True,
    samesite="lax",          # Logger の "strict" ではなく lax
    secure=COOKIE_SECURE,    # 環境変数駆動。dev では 0
    max_age=JWT_EXPIRE_DAYS * 86400, path="/",
)
```

- `samesite="lax"`: `strict` だと外部（チャットアプリのリンク等）から `radio.scrambler-lab.com` に遷移した際に Cookie が送られず、無言でログアウト状態に見える。状態変更は全て同一オリジンの POST / WS なので `lax` で安全。
- `secure` を環境変数化する理由: **Safari は `http://localhost` に Secure Cookie を保存しない**（Chrome/Firefox は許容する）。dev で Safari が使えなくなる。

### A.5 設定と秘密情報

dotenv ローダーが無いので1箇所だけ追加する。[backend/config.py](backend/config.py) の**最上部**（他のどのモジュールが env を読むより前）:

```python
from dotenv import load_dotenv
load_dotenv(Path.home() / ".generative-radio.env")   # docs/next-improvements-plan.md:209 の想定に合わせる
load_dotenv(Path(__file__).parent.parent / ".env")   # リポジトリローカルの上書き（gitignore）
```

`config.py` は `main.py` / `models.py` / `radio.py` から import されるので必ず最初に走る。

新規環境変数（[backend/auth.py](backend/auth.py) が読む）:
```
JWT_SECRET          # 必須。openssl rand -hex 32
JWT_EXPIRE_DAYS=30
INVITE_CODE         # signup に必須
COOKIE_SECURE=1     # start.sh は 0 を export
USERS_DB_PATH       # 既定 backend/users.db
```

**設定漏れは fail-fast ではなく fail-closed にする。** `JWT_SECRET` や `INVITE_CODE` が無い場合に uvicorn を落とすと、設定ミス1つでラジオ全体が停止してしまう。代わりに起動時に `CRITICAL` を1行出し、`/api/auth/*` は `503` を返し、認証依存関数は全て `401` を投げる。結果としてラジオは鳴り続け、DJ とオフラインだけが使えない。[backend/main.py](backend/main.py#L46-L60) の lifespan バナーにも状態を出力して見落とせないようにする。

**スクリプト変更**: `scripts/setup.sh` に `~/.generative-radio.env` を生成するステップを追加（`JWT_SECRET` を自動生成、`INVITE_CODE` はプロンプト、`chmod 600`、生成した招待コードを目立つ形で表示）。`scripts/start.sh` に `export COOKIE_SECURE=0` を追加。`scripts/start_prod.sh` は既定の `1` のまま。

### A.6 レート制限（[backend/ratelimit.py](backend/ratelimit.py)）

```python
_hits: dict[tuple[str, str], deque[float]] = defaultdict(deque)

def check(bucket: str, key: str, limit: int, window_s: float) -> None:
    """limit 回を window_s 秒で超えたら HTTPException(429) を投げる。"""
```

- `login`: IP ごと 5回/60秒 **かつ** email ごと 10回/15分（IP を変えたクレデンシャルスタッフィング対策）
- `signup`: IP ごと 3回/60秒 かつ 20回/24時間（招待コードの総当たり対策）
- `verify`: IP ごと 30回/60秒

キーは `netutil._resolve_request_ip(request)` を使う（`request.client.host` は Tunnel 越しでは常に 127.0.0.1）。辞書の無制限増加を防ぐため `MAX_BUCKET_ENTRIES` の上限と空 deque の遅延削除を入れる。`429` には `Retry-After` を付ける。

---

## B. トークン二系統（Cookie + Bearer）

### B.1 [backend/auth.py](backend/auth.py) のシグネチャ

```python
@dataclass(frozen=True, slots=True)
class AuthUser:
    id: str
    email: str
    nickname: str

def create_access_token(user: AuthUser) -> tuple[str, datetime]:
    """HS256 JWT。claims {sub, email, nick, iat, exp}。(token, expires_at) を返す。"""

def verify_token(token: str) -> AuthUser:
    """署名不正 / alg 不正 / 不正形式 / 期限切れ で HTTPException(401)。"""

def hash_password(plain: str) -> str: ...             # ブロッキング。asyncio.to_thread 経由で呼ぶ
def verify_password(plain: str, stored: str) -> bool: ...

def extract_token_http(request: Request) -> str | None:
    """Authorization: Bearer <t>  →  cookie 'auth_token'。先勝ち。"""

def extract_token_ws(ws: WebSocket) -> str | None:
    """Authorization ヘッダ → cookie 'auth_token' → クエリ 'token'。"""

async def get_current_user(request: Request) -> AuthUser:     # 無い/不正なら 401
async def get_optional_user(request: Request) -> AuthUser | None:  # 401 を投げず None
```

Logger との意図的な差分: `get_current_user` は email 文字列ではなく **dataclass** を返す。DJ パスがニックネームを、ライブラリパスがユーザー ID をログに必要とするため。**claims のみで DB を引かない** — `/api/library/audio/{id}` は1回のダウンロードで最大 500 回呼ばれるので DB ラウンドトリップは避ける。

`verify_token` は署名検証の前に `alg == "HS256"` を強制。期限は `datetime.now(timezone.utc)` 基準、クロックスキュー用に 60 秒の leeway。

### B.2 WebSocket 認証

[backend/main.py](backend/main.py#L400-L408) の現状:
```python
await websocket.accept()
radio.add_ws(websocket)
```

変更後:
```python
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    token = extract_token_ws(websocket)     # ヘッダ → Cookie → ?token=
    user: AuthUser | None = None
    if token:
        try:
            user = verify_token(token)
        except HTTPException:
            user = None                      # 拒否ではなく匿名リスナーに降格
    radio.add_ws(websocket, user=user, token=token)
```

**設計上の要点: トークンが不正/期限切れでもソケットは閉じない。** ラジオ再生は公開機能で、ゲートするのは DJ だけ。失敗したトークンは匿名接続に降格し、クライアントは `role_assigned.djAvailable === false` でそれを知る。

- **ブラウザ側は何もしなくてよい。** Starlette の `WebSocket` は `HTTPConnection` を継承しているので `websocket.cookies` がアップグレードリクエストの `Cookie` ヘッダから populate される。同一オリジンなのでブラウザは自動送信し、[frontend/vite.config.ts](frontend/vite.config.ts#L66-L69) の `/ws` プロキシは `changeOrigin` 無しなのでヘッダはそのまま通る。
- **モバイルは `?token=<jwt>` を付ける。** [mobile/src/config.ts](mobile/src/config.ts#L18-L23) の `WS_URL` はモジュールレベルの定数文字列なので**関数化が必要**:
  ```ts
  export const wsUrl = (token: string | null) =>
    `${__DEV__ ? 'ws://localhost:5555' : 'wss://radio.scrambler-lab.com'}/ws`
    + (token ? `?token=${encodeURIComponent(token)}` : '');
  ```
  [mobile/src/hooks/useRadio.ts](mobile/src/hooks/useRadio.ts#L905) の `new WebSocket(WS_URL)` を `new WebSocket(wsUrl(tokenRef.current))` に。同時に `?client=mobile` を削除する。

  **クエリ文字列の注意点**: トークンが uvicorn のアクセスログに残る。対策は uvicorn を `--no-access-log` で起動する（両 start スクリプトとも既に `/tmp/generative-radio-backend.log` にリダイレクトしているので失うものは少ない）。より綺麗な「接続後に `{"event":"auth"}` フレームを送る」方式は `add_ws` を2フェーズ化する必要があり [backend/radio.py](backend/radio.py#L176-L215) への変更が大きくなるので、フォローアップとする。

### B.3 CORS は変更しない

`allow_credentials` は未設定（False）のままにする。[backend/main.py](backend/main.py#L115) にコメントとして理由を残すこと:
- Web アプリは dev / prod とも API と**同一オリジン**なので、そもそも CORS のクレデンシャル付きリクエストにならない。
- モバイルはブラウザではないので CORS を強制せず、`Authorization` ヘッダは常に送られる。
- 「念のため」で `allow_credentials=True` にすると、`ALLOW_QUICK_TUNNEL=1` 時の `*.trycloudflare.com` 正規表現と組み合わさって任意の quick tunnel オリジンからクレデンシャル付きリクエストが可能になる。**有効化しないこと。**

---

## C. DJ ゲートの改修

### C.1 `add_ws`（[backend/radio.py](backend/radio.py#L176-L215)）

```python
def add_ws(self, ws: WebSocket, user: AuthUser | None = None, token: str | None = None) -> None:
    self._ws_connections.append(ws)
    ip = _resolve_client_ip(ws)
    is_local = _is_local_ip(ip)
    self._ws_meta[ws] = {
        "ip": ip,
        "connected_at": time.time(),
        "is_local": is_local,        # controller 適格性 — 変更しない（決定事項4）
        "user_id":   user.id if user else None,
        "nickname":  user.nickname if user else "",
        "auth_token": token,         # DJ 操作時の再検証用（C.4）
    }
```

削除するもの: `is_mobile = ws.query_params.get("client") == "mobile"` の行と `dj_available = is_local or is_mobile` の計算、およびそのコメントブロック。認証状態は保存せず `bool(meta.get("user_id"))` で都度導出する。

`_viewer_list_data()`（[backend/radio.py](backend/radio.py#L714-L726)）に `"nickname"` を追加すると、controller の視聴者リストに誰がログイン中か表示できてロールアウトのデバッグに有用。

### C.2 `role_assigned` ペイロードと promotion バグの修正

ビルダーを1つに抽出して、バグの再発を構造的に不可能にする:

```python
def _role_assigned_message(self, ws: WebSocket, role: str) -> WSMessage:
    meta = self._ws_meta.get(ws, {})
    return WSMessage(event="role_assigned", data={
        "role": role,
        "djAvailable": bool(meta.get("user_id")),   # 線名は維持、意味が「認証済み」に変わる
        "nickname": meta.get("nickname", ""),
    })
```

3箇所全てで使う: `_send_controller_snapshot`（[radio.py:682](backend/radio.py#L682)）、`_send_viewer_snapshot`（[radio.py:688](backend/radio.py#L688)）、そして **`_promote_next_controller`（[radio.py:709-712](backend/radio.py#L709-L712)）— ここが既存バグの修正点**。現状ここだけ `djAvailable` を送っておらず、controller に昇格したローカル視聴者は Web 側で `setDjAvailable(undefined)` となり DJ ボタンが消える。

線名 `djAvailable` は変えない（`authenticated` にリネームすると型定義2ファイルと [frontend/src/hooks/useRadio.ts](frontend/src/hooks/useRadio.ts#L336) 以降の prop チェーン全体に波及する）。代わりに型定義のコメントを「認証済みの接続で true」に更新する。

### C.3 `claim_dj_from_ws`（[backend/radio.py](backend/radio.py#L1476-L1491)）

```python
meta = self._ws_meta.get(ws, {})
if not meta.get("user_id"):
    await self._send_to(ws, WSMessage(event="dj_claim_ack",
                                      data={"granted": False, "reason": "auth_required"}))
    return
```

`reason` フィールドを追加することで、クライアントが「他の人が枠を取っている / まだロック中」（`reason: "locked"`）と「ログインが必要」を区別でき、後者ではログインモーダルを開ける。`DjClaimAckData` に `reason?: 'auth_required' | 'locked' | 'session_expired'` を追加。

### C.4 `submit_dj_from_ws` — ニックネームがフリーテキストを置き換える

**`djName` はクライアントのペイロードから完全に削除する。** 現状 [backend/main.py](backend/main.py#L427-L435) が `event_data.get("djName", "")` を読み、[backend/radio.py](backend/radio.py#L1517) が無検証で `self._dj_name` に代入している。つまり任意の WS クライアントが全リスナーに配信される DJ 名を自由に設定でき、それがサイドカーに永久保存される。**これは現時点で既になりすまし穴であり、ニックネーム制になった瞬間に本物の偽装問題になる。**

```python
async def submit_dj_from_ws(self, ws, genres, keywords, language, feeling) -> None:
    if ws != self._dj_claimant_ws:
        return
    meta = self._ws_meta.get(ws, {})
    nickname = meta.get("nickname", "")
    if not nickname:                                # claim と submit の間にトークンが失効
        self._dj_claimant_ws = None
        self._dj_lock_until = time.time()           # 枠を放置せず解放する
        await self._send_to(ws, WSMessage(event="dj_claim_ack",
                            data={"granted": False, "reason": "session_expired"}))
        await self._broadcast_dj_state()
        return
    self._dj_name = nickname
    ...
```

[backend/main.py](backend/main.py#L427-L435) から `dj_name=` kwarg を落とす。古いビルドが送ってくる `djName` は単に無視される（互換かつ安全に劣化）。

**`start_from_ws`（[backend/radio.py](backend/radio.py#L423-L443)）も `dj_name` を受け取っている。** controller はローカルネットワークで信頼されている（決定事項4）ので、安全な最小ルールは:「controller 接続が認証済みならニックネームで上書き、そうでなければフリーテキスト値を維持」。ログアウト状態のローカルホストは今まで通り動き、ログイン済みホストの名前は偽装不可能になる。

### C.5 長時間 WebSocket でのトークン失効

モバイルのソケットは数時間生きる。「接続時に取得した身元を永久に信用する」設計は将来的に必ず問題になる。

**特権的な入口2箇所だけで再検証する**（`claim_dj_from_ws` と `submit_dj_from_ws`）。`_ws_meta["auth_token"]` に保存したトークンを使う:

```python
def _refresh_ws_identity(self, ws: WebSocket) -> bool:
    """保存トークンを再検証し、失敗したら接続を匿名に降格する。"""
    meta = self._ws_meta.get(ws)
    if not meta or not meta.get("auth_token"):
        return False
    try:
        user = verify_token(meta["auth_token"])
    except HTTPException:
        meta["user_id"] = None; meta["nickname"] = ""; meta["auth_token"] = None
        asyncio.create_task(self._send_to(ws, self._role_assigned_message(
            ws, "controller" if ws is self._controller_ws else "viewer")))  # djAvailable:false を push
        return False
    meta["nickname"] = user.nickname
    return True
```

コストは DJ 操作あたり HMAC 検証2回。失効を検知した瞬間に `role_assigned` を再送するので、UI は「claim が失敗する」という分かりにくい形ではなく、ボタンがグレーアウトする形で伝わる。

**ログイン / ログアウト時は WS を張り直す。** これがもう半分で両クライアントに必要。ログイン成功後にソケットを閉じて開き直し、サーバに身元を読み直させる。Web は `AuthContext` が `authVersion` カウンタを公開し `useRadio` の接続 effect がそれに依存する形。モバイルは `useAuth` の変化を見る `useEffect` で `wsRef.current.close()`。**これが無いとログインしてもリロードするまで DJ ボタンが出ない。**

`radio.py` は `from auth import AuthUser, verify_token` を追加。循環 import は無い（`auth.py` は fastapi/stdlib/`users.py` のみ、`users.py` は stdlib のみ）。

---

## D. Web / モバイルの「共通」と「別開発」の切り分け

まず正直に上限を述べる。**`packages/shared` は TypeScript の型定義のみで、モバイルからしか使われておらず、Web は [frontend/src/types.ts](frontend/src/types.ts) に fork を持っていて既に乖離している。** 共通のランタイムコードもビルドステップもコンポーネント層も無い（Web は DOM + 1262行の `App.css`、モバイルは RN `StyleSheet` + `theme.ts`）。したがって「共通化できる」のは**型 + バリデーション定数 + 極小のフレームワーク非依存 auth クライアント**まで。それ以上は、このコードベースでは幻想である。

### D.1 まず fork を直す（PR 0）

Web は `packages/shared` と同じ npm workspace 内の Vite アプリなので、繋ぎ込みは安い:

1. `frontend/package.json` の dependencies に `"@radio/shared": "*"` を追加。
2. `packages/shared/package.json` は `main`/`types` が生の `./src/index.ts` を指しているので Vite にトランスパイルさせる: `frontend/vite.config.ts` に `optimizeDeps.exclude: ['@radio/shared']`、`frontend/tsconfig.app.json` に `paths` で `@radio/shared` → `../packages/shared/src` のマッピング。モバイルは Metro の workspace 解決で既に動いている。
3. `replay?: boolean` を `packages/shared/src/types.ts` の `Track` に移し、乖離した `AdvancedOptions` のコメントを揃え、`frontend/src/types.ts` を削除して5つの import 元（`App.tsx`, `hooks/useRadio.ts`, `components/{DJPanel,GenreSelector,RadioPlayer,StatusBar}.tsx`）を書き換える。

設定 ~30行 + 機械的な import 書き換え。**これを認証 PR より先にやること** — さもないと `AuthUser`、`RoleAssignedData.nickname`、`DjClaimAckData.reason`、バリデーション定数の全てが二重に書かれて再び乖離する。

### D.2 切り分け表

| 対象 | 配置 | 補足 |
|---|---|---|
| `AuthUser`, `LoginRequest/Response`, `SignupRequest/Response`, `AuthErrorCode` union | **共通** — `packages/shared/src/auth.ts`（新規） | 純粋な型 |
| `RoleAssignedData` + `nickname`、`DjClaimAckData` + `reason` | **共通** — `packages/shared/src/types.ts` | 既に共通。D.1 後に Web も参加 |
| バリデーション定数と述語: `NICKNAME_MIN/MAX`, `NICKNAME_RE`, `PASSWORD_MIN/MAX`, `EMAIL_RE`, `validateNickname()` 等 | **共通** — `packages/shared/src/validation.ts`（新規） | DOM/RN 非依存の純関数。**Python 側（`backend/routers/auth.py`）のルールと厳密に一致させ、両側にお互いを指すコメントを置く。** 共通ランタイムコードの中で最も価値が高い部分 |
| `createAuthClient({baseUrl, getToken})` → `{login, signup, logout, verify}` | **共通** — `packages/shared/src/authClient.ts`（新規） | フレームワーク非依存、グローバル `fetch` を使用（RN 0.83 / ブラウザ両方にある）。Web は `baseUrl: ''` + `credentials:'include'` + `getToken: () => null`、モバイルは `baseUrl: BACKEND_URL` + SecureStore の `getToken`。約80行、二重実装を回避 |
| **トークン保存** | **別開発** | Web: 何もしない（httpOnly Cookie、JS から不可視）。モバイル: `expo-secure-store`（新規依存、Keychain/Keystore）。仕組みが根本的に違うので抽象化する価値は無い |
| **認証状態コンテナ** | **別開発（二重実装）** | Web: `frontend/src/context/AuthContext.tsx`（React Context、Logger の `AuthContext.tsx` をそのまま踏襲）。モバイル: `mobile/src/hooks/useAuth.ts`（36行の `mobile/src/App.tsx` から `AppNavigator` に prop で渡せるので Context 不要）。どちらも約90行。**Web は `POST /verify` のラウンドトリップで、モバイルは SecureStore から非同期に hydrate するため、共通抽象のコストのほうが高い** |
| **ログイン/サインアップ UI** | **別開発（二重実装）** | Web: `frontend/src/components/AuthModal.tsx` + `App.css` に約90行の BEM CSS（**既存の `.dj-panel-backdrop` / `.dj-panel` クラスを再利用して DJ パネルと見た目を揃える**）。モバイル: `mobile/src/components/AuthModal.tsx` — RN `<Modal>` + `theme.ts` の `StyleSheet`、既存 `OfflinePanel.tsx`（フォーム付きモーダルの最も近い前例）を構造的に踏襲。DOM `<input>` と RN `<TextInput>` の間にコード再利用は不可能 |
| **ナビゲーション** | **別開発（どちらも些細）** | Web: ルーター無し。`App.tsx` の `{radio.djPanelOpen && <DJPanel/>}`（[frontend/src/App.tsx](frontend/src/App.tsx#L59-L61)）の隣に条件付きで `<AuthModal>` を置く。モバイル: `AppNavigator.tsx` の `DJPanel`/`OfflinePanel` と並べて4つ目の兄弟として追加。**`Stack.Navigator` は導入しない** — 画面1つのために大規模リファクタになる |
| **DJ 名入力欄** | **両方で削除** | [frontend/src/components/DJPanel.tsx](frontend/src/components/DJPanel.tsx) の 31, 110-113, 117, 231 行と [mobile/src/components/DJPanel.tsx](mobile/src/components/DJPanel.tsx) の 35, 106, 113, 227-237 行。`djName` state、`nameError` state、`handleSubmit` のガード、`<input>`/`<TextInput>` ブロックを全て削除。`onSubmit` の第5引数が消え、両プラットフォームの `useRadio.submitDj` に波及。代わりに「DJ: **{nickname}**」の読み取り専用行を置く |
| **バックエンド契約** | 共通化不可（Python） | バリデーションルールは TS と Python に必然的に二重存在。上記のクロスリファレンスコメントと §G の pytest ケースで担保 |

**結論**: `packages/shared` に小さい新規ファイル3つ（合計 ~200行）、認証状態コンテナ2つ、ログイン UI 2つ。これが正直な比率であり、それで良い。重複しているのは重複が避けられない層だけ。

---

## E. オフラインモード：バグ修正 + 会員限定化

### E.1 P0 — 「オンラインとオフラインが同時に鳴る」バグ

**原因を特定済み。プレイヤーインスタンスが2つあるのではない**（`playerRef` は1つしかない）。真因は **`expo-audio` の `AudioPlayer.remove()` が再生を止めないこと**。ネイティブ実装は登録簿から外すだけ:

```swift
// node_modules/expo-audio/ios/AudioModule.swift:251
Function("remove") { player in self.registry.remove(player) }   // これだけ
// 同:244 — 実際に音を止めるのは pause() だけ
Function("pause") { player in player.ref.pause(); ... }
```
Android も同一（`AudioModule.kt:494` → `players.remove(player.id)`）。

そして [mobile/src/hooks/useRadio.ts](mobile/src/hooks/useRadio.ts#L517) の `playOfflineTrack` は:
```ts
playerRef.current?.remove(); playerRef.current = null;   // pause() も clearLockScreenControls() も無い
...
player.play();                                           // ← 2本目のストリームが開始
```
つまりオンライン側の AVPlayer/ExoPlayer が `documents/track_current.mp3` をデコードし続けたまま、オフライン側が再生を始める。**方向性のあるバグ**であることが症状と完全に一致する: オフライン→オンライン（BACK TO ONLINE MODE）は `exitOfflineMode`（[:1238-1243](mobile/src/hooks/useRadio.ts#L1238-L1243)）と `tuneOut`（[:1192-1199](mobile/src/hooks/useRadio.ts#L1192-L1199)）が `pause()` を呼んでいるので綺麗。オンライン→オフラインだけが二重再生する。

**修正:**

1. `stopSilenceBridge` の隣（~:310）にヘルパーを1つ追加:
   ```ts
   const teardownPlayer = useCallback(() => {
     const p = playerRef.current;
     playerRef.current = null;                    // 先に null 化して再入時の二重解体を防ぐ
     if (!p) return;
     try { p.clearLockScreenControls(); } catch (e) { console.warn('[Audio] clearLockScreen failed', e); }
     try { p.pause(); }                   catch (e) { console.warn('[Audio] pause failed', e); }
     try { p.remove(); }                  catch (e) { console.warn('[Audio] remove failed', e); }
   }, []);
   ```
   順序が重要: `remove()` はネイティブ登録簿から切り離すので、その後の呼び出しは throw する。必ず `pause()` を先に。
2. 4箇所を全て置換: `playOfflineTrack`（[:517](mobile/src/hooks/useRadio.ts#L517)）、`fetchAndPlay` のオンライン経路（[:723-725](mobile/src/hooks/useRadio.ts#L723-L725)、WS `play_now` 割り込みと `playbackState === 'failed'` 復帰では同じ潜在バグがある）、`tuneOut`、`exitOfflineMode`。後2者は既に正しいが、ヘルパー経由にして今後もそれを保つ。
3. **早期 return の修正。** [:515](mobile/src/hooks/useRadio.ts#L515) の `if (!playerReadyRef.current) return;` は古いプレイヤーに触る**前**に発火するので、`enterOfflineMode` が `offlineMode=true`・バナー表示・オンライン曲は鳴りっぱなし、という状態で完了してしまう。準備チェックを `enterOfflineMode`（[:1203](mobile/src/hooks/useRadio.ts#L1203)）の**状態変更前**に移す。`playOfflineTrack` 側のガードも残すが `teardownPlayer(); setRadioState('error'); setErrorMessage('Audio engine not ready');` に変えて無言で失敗しないようにする。
4. `AudioPlayer` は `SharedObject` を継承しているので `release()` が実行時には存在し、ネイティブの確定的解放を強制できる。ただしその後の全メソッド呼び出しが throw するようになり `attachStatusListener` の購読ライフサイクルと干渉する。**`pause()` が正式かつ十分な修正**なので、TODO コメントを残してフォローアップ扱い。

### E.2 P1 — データ損失と正しさ

5. **[mobile/src/utils/offlineLibrary.ts:156-164](mobile/src/utils/offlineLibrary.ts#L156-L164) — ステージングディレクトリ + 成功時スワップ。** `offline/tracks.staging/` にダウンロードし、完了時（またはキャンセルでも1件以上成功していれば）に `offline/tracks` を削除して staging をリネームする。これで2つのバグが同時に消える: (a) 空き容量チェックが「これから解放される分」を考慮する必要がなくなる、(b) 1件目でネットワークが切れても既存ライブラリが無傷で残る。起動時に孤児 `tracks.staging/` を掃除する処理も追加。
6. **同関数 — 空き容量見積もりの修正。** `AVG_TRACK_BYTES = 6MB` × 500 で約 3.1GB を要求するが実際のトラックは約 3.8MB。index は既に手元にあるのでサイドカーにサイズがあれば実測値を合計、無ければ `4MB` × 1.2 の余裕率。エラーメッセージには必要量と空き容量の両方を出す。
7. **[offlineLibrary.ts:189](mobile/src/utils/offlineLibrary.ts#L189) — サイドカー書き込みを per-file の try/catch の内側に移す。** 現在ディスクフルの書き込み失敗が `for` ループの外まで throw し、残りのキュー全体を中断する。失敗時は書き込み済み mp3 を削除し（「json があれば mp3 は完全」の不変条件を守るため）`failed++` して `continue`。
8. **[offlineLibrary.ts:173-185](mobile/src/utils/offlineLibrary.ts#L173-L185) — リトライ前に部分ファイルを削除する。** `expo-file-system` の Android 実装はレスポンスボディを直接 destination に流し込むため、途中で切れると truncate された `.mp3` が残る（これが Android の孤児ファイルリーク）。`catch` の先頭に `try { if (mp3.exists) mp3.delete(); } catch {}` を移動。
9. **[useRadio.ts:506-512](mobile/src/hooks/useRadio.ts#L506-L512) `dropOfflineTrack` のインデックスバグ。** `filter()` 後も `offlineQueuePosRef` が同じ整数を指しており、それは別の曲を指すようになる。結果として失敗が1件起きるたびに正常な曲が1つ無言でスキップされる:
   ```ts
   const idx = offlineQueueRef.current.indexOf(id);
   offlineQueueRef.current = offlineQueueRef.current.filter(x => x !== id);
   if (idx !== -1 && idx <= offlineQueuePosRef.current) offlineQueuePosRef.current -= 1;
   if (offlineQueuePosRef.current >= offlineQueueRef.current.length) offlineQueuePosRef.current = -1;
   ```
10. **[useRadio.ts:545-556](mobile/src/hooks/useRadio.ts#L545-L556) — iOS バックグラウンドでの無言停止。** `meta.duration` が無いと `ms === 0` でバックアップタイマーが張られず、**しかもステータスリスナーは直前に外されている**ので、バックグラウンドで曲が終わると復帰手段なく停止する。`ms <= 0` の場合は `player.duration` にフォールバックし、それも使えなければ**リスナーを外さない**（`didJustFinish` を唯一の経路として残す、オンライン経路の [:790](mobile/src/hooks/useRadio.ts#L790) の警告のみの挙動に揃える）。最後の砦として `MAX_TRACK_MS = 6 * 60_000` の上限ウォッチドッグも張る。
11. **[useRadio.ts:1233](mobile/src/hooks/useRadio.ts#L1233) `exitOfflineMode` — オフライン状態を壊す前に到達性チェック。** まず `fetch(BACKEND_URL + '/api/radio/status', {signal: AbortSignal.timeout(4000)})` を試し、失敗したら「まだオフラインです」と表示して `offlineTracksRef`/`offlineQueueRef` をクリアせずプレイヤーも壊さずに return。現状、機内モードで「Back to Online Mode」を押すとオフライン状態が全消去され、何も鳴らないまま3秒ごとの無限リトライループに落ちる。
12. **[useRadio.ts:1202](mobile/src/hooks/useRadio.ts#L1202) `enterOfflineMode`** に冪等ガード `if (offlineModeRef.current) return;` を追加（`exitOfflineMode` には既にある）。加えて進行中の `@kesha-antonov` バックグラウンドダウンロードタスクを `getExistingDownloadTasks()` → `stop()` でキャンセルする（`mobile/src/utils/downloadAudio.ts` に `cancelCurrentDownload()` を export）。

### E.3 P2 — UX と多層防御

13. **[OfflinePanel.tsx:40,50,98](mobile/src/components/OfflinePanel.tsx#L40) — `existingCount` を `handleDownload` の全終了経路で更新する**（現状 `result.cancelled` の分岐のみ）。`finally { setExistingCount(scanOfflineTracks().length); }` で十分。現状ダウンロード失敗後に「PLAY EXISTING TRACKS (312)」が表示されるのに実際は0件で、[:116-121](mobile/src/components/OfflinePanel.tsx#L116-L121) の `handlePlayExisting` が無言で no-op する。「ダウンロード済みの曲がありません」の明示メッセージも追加。
14. **[OfflinePanel.tsx:38,56,104,112,188-194](mobile/src/components/OfflinePanel.tsx#L38) — `indexError` を3つの状態に分割**: `indexError`（index 取得失敗 / ライブラリ無効）、`downloadError`（ダウンロード失敗 / 容量不足）、そして「Found N」行は置き換えられずに独立して表示する。フィルタ変更（`keyword`/`genreId`/`maxTracks`）時に `downloadError` をクリア。
15. **[offlineLibrary.ts:54-56](mobile/src/utils/offlineLibrary.ts#L54-L56) `fetchLibraryIndex` — `res.ok` だけでなく `enabled` フラグも見る。** ライブラリのボリュームが未マウントだと `{enabled:false, count:0, tracks:[]}` が返り、現状は何食わぬ顔で「Found 0 tracks」と表示される。専用の `LibraryDisabledError` を投げる。ここと `/api/genres` fetch に `AbortSignal.timeout(15_000)` を追加。
16. **[offlineLibrary.ts:84-101](mobile/src/utils/offlineLibrary.ts#L84-L101) `scanOfflineTracks`** はパネルを開くたびに最大500件の 2-4KB サイドカーを JS スレッド上で同期的に `textSync()` + `JSON.parse` している。**修正5でスワップを入れるならその時に `offline/manifest.json` を書き、それだけを読む**（manifest が無ければフルスキャンにフォールバック）。ほぼ追加コスト無しで解決する。
17. **「自己削除しない」不変条件をコードで守る。** 現状 [RadioPlayer.tsx:379](mobile/src/components/RadioPlayer.tsx#L379) の JSX 三項演算子だけが担保しており、[AppNavigator.tsx:61](mobile/src/navigation/AppNavigator.tsx#L61) は `onOpenOfflinePanel` を無条件で渡している。`downloadTracks` に明示的な `allowClear: boolean` を渡す形にし、`AppNavigator.tsx:61` も `onClaimDj`（[:56](mobile/src/navigation/AppNavigator.tsx#L56)）と対称に `offlineMode ? undefined : ...` でゲートする。
18. **オフラインモードが再起動をまたいで永続化されない。** 機内モードでのコールドスタートは必ずオンラインラジオで起動しリトライループに入る。`offline/state.json` を enter 時に書き exit 時に消し、マウント時にそれと manifest（1件以上）があればオフラインモードで直接起動する。「飛行機で使える」と「飛行機でアプリを閉じなければ使える」の差。
19. **バックエンド**: [backend/library.py:252](backend/library.py#L252) の未使用 `get_meta()` を削除。[/api/library/index](backend/main.py#L221-L227) に ETag を追加（シリアライズ済み JSON を `TrackLibrary` にキャッシュし `adopt()`/eviction でバージョンを上げる、`If-None-Match` 一致で `304`、`Cache-Control: private, max-age=60`）。歌詞はペイロードに残す（オフラインで `metaToTrack` が必要とするため）。パネルを開くたびの 1-2MB のイベントループ上シリアライズがハッシュ比較になる。

### E.4 会員限定化

**バックエンド**（[backend/main.py](backend/main.py#L221-L244)）— このリポジトリ初の `Depends()` 使用:
```python
@app.get("/api/library/index")
async def get_library_index(user: AuthUser = Depends(get_current_user)):

@app.get("/api/library/audio/{track_id}")
async def get_library_audio(track_id: str, user: AuthUser = Depends(get_current_user)):
```
`extract_token_http` 経由なので Cookie でも Bearer でも通る。`user.id` をログに出して誰が一括ダウンロードしているか見えるようにする。1回のダウンロードが 500 リクエストなので、粗いレート制限（ユーザーあたり 600 リクエスト/10分程度）も検討。

**モバイル:**
- [offlineLibrary.ts:54](mobile/src/utils/offlineLibrary.ts#L54) `fetchLibraryIndex(token)` に `headers: { Authorization: 'Bearer ' + token }`。
- [offlineLibrary.ts:172](mobile/src/utils/offlineLibrary.ts#L172) `File.downloadFileAsync(url, mp3, { headers: {...}, idempotent: true })` — `DownloadOptions.headers` は**サポート確認済み**。
- `401` を専用エラーとして扱う（`AuthRequiredError`）。パネルは汎用の「Library unavailable — check connection」ではなく「セッションが切れました。再ログインしてください」を出して認証モーダルを開く。
- **UI ゲート**: [AppNavigator.tsx:61](mobile/src/navigation/AppNavigator.tsx#L61) を `onOpenOfflinePanel={isAuthenticated && !offlineMode ? () => setOfflinePanelOpen(true) : undefined}` に。[:56](mobile/src/navigation/AppNavigator.tsx#L56) の `onClaimDj` にも `djAvailable &&` を追加。

**オフラインモード中にログアウトした場合の挙動:**
- **ログアウトは許可する**（ボタンを無効化して説明を出すより、素直に動くほうが良い）。ただし**再生は止めず、ダウンロード済みファイルも削除しない。** それらはダウンロード時点で認可されたもので、再生中に消すのは §E.1 で潰したのとまさに同種のバグを生む。
- オフラインセッションは最後まで継続。Offline Mode ボタンは既に到達不能（RadioPlayer の三項で「Back to Online Mode」しか出ない）なので新規ダウンロードは開始できない。
- **`exitOfflineMode` を認証対応にする**: 退出時に未認証なら匿名リスナーとしてオンラインに降りる。ラジオは誰にでも鳴り、DJ と Offline Mode ボタンが単に無いだけ。エラー状態ではなく穏やかな着地。
- ログアウトの POST は短いタイムアウトで fire-and-forget（オフラインでは当然失敗する。実際に効くのはローカル SecureStore の削除）。

---

## F. 移行と互換性

**壊れるもの（影響度順）:**

1. **インストール済みのモバイルビルド（v1.5.0）が DJ 権限を恒久的に失う。** 現在 `?client=mobile` で DJ を得ている（[mobile/src/config.ts](mobile/src/config.ts#L20-L23)）が、`add_ws` がこのパラメータを無視するようになると全ての旧ビルドが匿名視聴者になる。ログイン UI が無いのでストア更新なしには復帰できない。**これは回避不可能で、最大のユーザー影響。** 緩和策:
   - WS の未知パラメータは寛容に無視する（`add_ws` は接続を拒否しないので、旧ビルドでも音声は鳴り続ける — 確認済み）。
   - 新ビルドは `?v=1.6.0` を送るようにし、`v` の無い接続には `error` イベントで「アプリを更新すると DJ モードが使えます」を送る。旧ビルドの `useRadio.ts` は `msg.event === 'error'` を `setErrorMessage` に流すので実際に表示される。
   - **モバイルビルドを先に出し、1週間ほど普及を待ってからバックエンドのゲートを立てる。**
2. **旧ビルドはオフラインモードも失う**（`/api/library/*` が要認証になるため）。「Library unavailable」と誤解を招く表示になるが破壊的ではない。同じ緩和策。
3. **ダウンロード済みトラックは旧ビルドでも動き続ける** — ローカルファイルで `scanOfflineTracks` はネットワークに触れない。
4. **ローカルネットワークで DJ ボタンが見えていた Web ユーザーは、サインアップするまで DJ を失う。** controller 権限（start/stop/skip/advanced options）は IP ベースのまま残るので保持される。意図通りだが「DJ になるにはサインアップ」の一行案内を UI に置く。
5. **フリーテキストの DJ 名が消える。** 既存トラックのサイドカーにある `dj_name` は表示専用なので移行不要。
6. **[README.md](README.md#L68-L75)** が旧 DJ フロー（「視聴者が名前を入力する DJ パネルが開く」）を説明している。DJ 変更と同じ PR で更新。
7. **`backend/users.db` を .gitignore に追加**し、バックアップ対象にする（ライブラリボリューム以外で唯一の状態を持つファイル）。
8. **初回ブートストラップ**: 招待制でユーザーゼロなので、誰かがサインアップするまで誰も DJ できない。`scripts/setup.sh` が生成した招待コードを目立つ形で出力すること。招待フロー抜きで最初のアカウントを作る `backend/scripts/create_user.py` CLI（既存の `library_maintenance.py` の兄弟）も用意すると安心。

**ロールアウト順序（厳守）:**

```
1. バックエンドをデプロイ（認証エンドポイントは稼働、DJ/library のゲートは OFF = AUTH_ENFORCE=0）
2. Web をデプロイ（ログイン UI が即座に使える。ストア審査不要）
3. モバイルビルドを申請・審査・リリース → 普及を待つ
4. AUTH_ENFORCE=1 に切り替え → DJ + library が全員ログイン必須に
```

`AUTH_ENFORCE` を `radio.py` / `main.py` で読む env 変数1つにしておけば、手順4がデプロイではなく再起動だけで済み、ワンコマンドでロールバックできる。約6行の価値はある。

---

## G. 検証手順

テストフレームワークが存在しないので、大半は手動。ただし**認証モジュールだけは pytest を入れる**（下記 G.4）。

### G.1 バックエンド — curl

```bash
BASE=http://localhost:5555
C=/tmp/radio-cookies.txt

# 設定前は 503
curl -si $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"email":"a@b.c","password":"x"}'

# signup: 招待コード不正 → 403
curl -si $BASE/api/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"nobu@example.com","password":"correcthorse","nickname":"Nobu","inviteCode":"WRONG"}'

# signup: 正しい招待コード → 201 + Set-Cookie（httponly/samesite/secure を目視確認）
curl -sic $C $BASE/api/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"nobu@example.com","password":"correcthorse","nickname":"Nobu","inviteCode":"'$INVITE_CODE'"}'

# email 重複 → 409 / nickname を大文字にして重複 → 409（大小無視の一意性）
# login → Cookie フロー
curl -sic $C $BASE/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"nobu@example.com","password":"correcthorse"}'
curl -si -b $C $BASE/api/auth/verify -X POST          # 200
curl -si -b $C $BASE/api/auth/logout -X POST
curl -si -b $C $BASE/api/auth/verify -X POST          # 401

# login → Bearer フロー（モバイル）
TOKEN=$(curl -s $BASE/api/auth/login -H 'Content-Type: application/json' -H 'X-Auth-Transport: bearer' \
  -d '{"email":"nobu@example.com","password":"correcthorse"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -si -H "Authorization: Bearer $TOKEN" $BASE/api/auth/verify -X POST      # 200
curl -si -H "Authorization: Bearer ${TOKEN%?}X" $BASE/api/auth/verify -X POST # 401（署名改竄）

# library ゲート
curl -si $BASE/api/library/index                                     # 401
curl -si -H "Authorization: Bearer $TOKEN" $BASE/api/library/index    # 200
curl -sI "$BASE/api/library/audio/<known-id>"                         # 401

# レート制限: 1分間に6回目のログイン → 429 + Retry-After
for i in $(seq 1 6); do curl -so /dev/null -w '%{http_code}\n' $BASE/api/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"nobu@example.com","password":"WRONG"}'; done

# 期限: JWT_EXPIRE_DAYS=0 で再起動し verify が 401 になることを確認
```

**WebSocket**（`websocat` またはブラウザコンソール）:
```bash
websocat "ws://localhost:5555/ws"                # role_assigned djAvailable:false を期待
websocat "ws://localhost:5555/ws?token=$TOKEN"   # djAvailable:true, nickname:"Nobu"
websocat "ws://localhost:5555/ws?token=garbage"  # 接続は成功し djAvailable:false
# 各接続で {"event":"dj_claim"} を送り dj_claim_ack.granted / .reason を比較
# 最重要 — なりすましテスト:
# {"event":"dj_submit","data":{"genres":["rock"],"keywords":[],"language":"en","feeling":"","djName":"IMPOSTOR"}}
#   → dj_state.activeDjName が "Nobu" であり "IMPOSTOR" でないことを確認
```

### G.2 Web — 手動

1. ログアウト状態で `http://localhost:5173` をコールドロード → DJ ボタン無し、ラジオは鳴る、controller コントロールは表示される（ローカル IP）。
2. モーダルでサインアップ → WS が再接続 → **ページリロードなしで** DJ ボタンが出る（§C.5 の配線検証）。
3. DJ を claim → パネルに**名前入力欄が無く**「DJ: Nobu」と表示 → submit → 別ブラウザでも `dj_state.activeDjName` が "Nobu"。
4. ログアウト → DJ ボタンが即座に消える。
5. **`_promote_next_controller` バグの回帰テスト**: ローカルのブラウザ2つを両方ログイン状態で開く。controller のタブを閉じる。昇格したタブが `djAvailable: true` 付きの `role_assigned` を受け取り DJ ボタンを保持することを確認。
6. **Safari で `http://localhost:5173`** — `COOKIE_SECURE=0` でログインできること、`COOKIE_SECURE=1` では失敗することの両方を確認（env が効いていることの証明）。
7. `start_prod.sh` の `https://radio.scrambler-lab.com` で、Cookie が Vite preview プロキシを往復して残ることを確認。DevTools → Application → Cookies でドメイン `radio.scrambler-lab.com`、`HttpOnly ✓`、`Secure ✓`、`SameSite Lax`。

### G.3 モバイル — 実機シナリオ

**P0 バグの再現手順（最重要）:**
1. 起動しオンライン曲が鳴っている状態にする → 2. Offline Mode を開き5曲ダウンロード → オフラインに入る → 3. **ヘッドホンで30秒聴く**。修正前は2つのストリームが重なって聞こえ、修正後は1つだけ → 4. 手順2の後に機内モードにして再実行 → 5. 逆方向（オフライン→オンライン）が回帰していないことも確認。

その他:
- Android でダウンロード中にアプリを kill → 再起動 → 孤児 `.mp3` が無く、以前のライブラリが無傷（ステージングスワップの検証）。
- 機内モードで「Back to Online Mode」→ 拒否されオフラインのまま曲も保持（修正11）。
- ファイルを壊す（`echo garbage > tracks/<id>.mp3`）→ スキップされるのが2曲ではなく1曲だけ（修正9）。
- `duration` の無いサイドカーで iOS バックグラウンド再生 → 継続すること（修正10）。
- オフライン中にログアウト → 再生継続・ファイル無傷。退出すると匿名オンラインになり DJ/Offline ボタンが無い（§E.4）。
- ログアウト状態 → Offline Mode ボタンと DJ ボタンが両方とも非表示。
- 旧ビルドのシミュレーション: 1つ前のモバイルコミットを checkout して新バックエンドに接続 → 音声は鳴り、「アプリを更新してください」メッセージが出る。

### G.4 pytest を入れるか

**入れる。ただし認証モジュールに限定する。** 理由は一般論ではなく具体的: HS256 とパスワード KDF を扱うのは、**手動テストでは見えず本番で致命的になる**唯一の領域だから。このリポジトリの他の部分（LLM → ACE-Step → 音声）は本質的にユニットテストが難しく、手動検証が正しい選択。認証はその逆。

- `backend/requirements-dev.txt`: `pytest>=8.0` のみ（`httpx` と `starlette.testclient` は既にある）。
- `backend/tests/test_auth.py`（~120行）: ハッシュの往復、誤パスワード、ハッシュ形式の安定性、トークン往復、署名改竄、`alg` を `none` / `HS512` に差し替え、期限切れ、`sub` 欠落、`extract_token_http` の優先順位（ヘッダが Cookie に勝つ）、`extract_token_ws` の優先順位。
- `backend/tests/test_auth_routes.py`（~120行）: 素の `FastAPI()` に auth ルーターだけをマウントし `USERS_DB_PATH` を `tmp_path` に向けた `TestClient`。**これがルーターを `APIRouter` にする理由**（`main.py` を import すると `:35-41` で Ollama に接続しにいく）。signup 正常系、招待コード不正、email 重複、nickname の大小無視重複、login/verify/logout の Cookie ライフサイクル、Bearer ライフサイクル、429、共通 TS 定数と一致するバリデーション拒否。
- `backend/tests/test_users.py`（~60行）: スキーマ作成の冪等性、一意制約、`disabled` フラグ。

実行: `backend/.venv/bin/python -m pytest backend/tests`。CI は無いので README に一行追記し、PR 説明に実行した旨を書く。

---

## H. フェーズ分割と進め方

### 運用ルール（厳守）

1. **同時に複数の PR を作らない。** 1本ずつ、順番に。
2. 各 PR は「実装 → 私が自動検証 → **人（ユーザー）による受け入れテスト** → OK ならマージ → 次の PR」の順で進める。
3. **人のテストが OK になるまで次の PR には着手しない。**
4. Web で一通り動作確認してから、モバイルビルドの作成に移る。
5. Radio は現在 `start_prod.sh` で稼働中。バックエンド変更時は再起動が必要なので、都度停止・再起動して構わない。

### 実施順序

Web 側を先に完成させる方針に合わせ、モバイル系の PR（旧 2-4）を後ろに寄せる。ただし **P0 の二重再生バグ修正だけは、コードが小さく独立しているので Web 完了後すぐ**（PR 5）に置く。

---

### PR 1 — `refactor/shared-types-for-web`（挙動変更なし）

Web を `@radio/shared` に接続。`replay?: boolean` を共通 `Track` に移し、乖離した `AdvancedOptions` コメントを揃え、`frontend/src/types.ts` を削除して import 元（`App.tsx`, `hooks/useRadio.ts`, `components/{DJPanel,GenreSelector,RadioPlayer,StatusBar}.tsx`）を書き換え、tsconfig の paths と `optimizeDeps.exclude` を追加。

**私が確認すること**: `npm run build --workspace=frontend` が通る。

**👤 人による受け入れテスト（マージ条件）**
- [ ] `./scripts/start_prod.sh` で起動し、`http://localhost:5173` を開く。ラジオが今まで通り再生される。
- [ ] ジャンル選択 → START が動く（controller 操作）。
- [ ] DJ パネルが開き、名前を入れて submit できる（この時点ではまだ旧仕様）。
- [ ] 👍/👎 リアクションと SAVE が動く。
- [ ] **要は「見た目も挙動も何も変わっていない」ことの確認。**

---

### PR 2 — `feat/backend-auth`（バックエンドのみ。まだ何もゲートしない）

`backend/users.py`, `auth.py`, `ratelimit.py`, `routers/auth.py`, `netutil.py`、`config.py` の dotenv 読み込み、`requirements.txt` + `requirements-dev.txt`、`backend/tests/`、`scripts/setup.sh` の env 生成、`scripts/start.sh` の `COOKIE_SECURE=0`、`.gitignore` に `users.db`。

**私が確認すること**: §G.1 の curl 一式を実行して結果を貼る。`pytest backend/tests` が全て通る。

**👤 人による受け入れテスト（マージ条件）**
- [ ] `~/.generative-radio.env` が生成され、**招待コードが表示されたことを確認**（このコードは以降のテストで使う。控えておく）。
- [ ] `./scripts/start_prod.sh` を再起動し、**ラジオが今まで通り再生される**（認証追加でラジオが壊れていないこと。これが最重要）。
- [ ] 起動ログのバナーに認証設定の状態が出ている。
- [ ] ブラウザで `http://localhost:5555/docs` を開き `/api/auth/*` の4エンドポイントが並んでいる。
- [ ] （任意）ターミナルで §G.1 の signup の curl を実行し、自分のアカウントを1つ作る。

---

### PR 3 — `feat/web-auth-ui`（Web のみ。ログイン UI が動く）

`packages/shared/src/{auth,validation,authClient}.ts`、`frontend/src/context/AuthContext.tsx`、`frontend/src/components/AuthModal.tsx`、`App.css` への BEM CSS 追加（既存 `.dj-panel` 系を再利用）、`main.tsx` の Provider ラップ、ログイン/ログアウト時の WS 再接続。**DJ ゲートはまだ OFF** なので DJ ボタンの挙動は不変。

**私が確認すること**: `npm run build --workspace=frontend` が通る。

**👤 人による受け入れテスト（マージ条件）**
- [ ] ヘッダ（またはプレイヤー上）に「ログイン」ボタンが出ている。デザインが既存の DJ パネルと調和している。
- [ ] **サインアップ**: 招待コード + メール + パスワード + ニックネームで登録できる。
- [ ] 招待コードを**間違える**と「招待コードが正しくありません」と出る。
- [ ] パスワード7文字、ニックネーム1文字などで**送信前に**エラーが出る。
- [ ] 同じメールで再登録 → 「このメールアドレスは登録済みです」。
- [ ] 同じニックネームを**大文字にして**登録 → 「このニックネームは使用されています」。
- [ ] **ログイン済み表示**: ニックネームが画面に出ている。
- [ ] **ページをリロードしてもログイン状態が保たれる**（Cookie によるセッション復元）。
- [ ] **ログアウト** → ログイン前の表示に戻る。
- [ ] パスワードを間違えてログイン → エラーが出る。**6回連続で間違えると「しばらく待ってください」**（レート制限）。
- [ ] **Safari** で `http://localhost:5173` を開き、ログインできる（`COOKIE_SECURE=0` の確認）。
- [ ] **`https://radio.scrambler-lab.com` 経由でもログインできる**（Tunnel + Vite プロキシ越しの Cookie）。DevTools → Application → Cookies で `auth_token` が `HttpOnly ✓ / Secure ✓ / SameSite Lax` になっている。
- [ ] ログイン・ログアウトのたびにラジオの再生が途切れない（WS 再接続が滑らか）。

---

### PR 4 — `feat/dj-requires-login`（ゲート切り替え。バックエンド + Web）

`add_ws(ws, user, token)`、`_role_assigned_message` ヘルパー（**`_promote_next_controller` バグを修正**）、`claim_dj_from_ws` の認証チェック + `reason`、`submit_dj_from_ws` の `dj_name` 削除とニックネーム使用、`start_from_ws` のニックネーム上書き、`main.py` の WS トークン抽出 + `include_router`、`/api/library/*` の `Depends(get_current_user)`、**Web の `DJPanel.tsx` から DJ 名欄を削除**、`AUTH_ENFORCE` フラグ、README 更新。

> モバイル側の `DJPanel.tsx` の名前欄削除と `?client=mobile` の廃止は **PR 7 に含める**（モバイルビルドを出すまで旧アプリを壊さないため）。この PR では `add_ws` から `?client=mobile` 判定を外すので、**旧モバイルアプリはこの時点で DJ を失う**。ユーザー了承済み。

**私が確認すること**: §G.1 の WS 一式（特になりすましテスト）を `websocat` で実行して結果を貼る。

**👤 人による受け入れテスト（マージ条件）**
- [ ] **ログアウト状態**で `http://localhost:5173` → ラジオは鳴る。**DJ ボタンが無い**。
- [ ] ただし **START / STOP / SKIP / advanced options は使える**（ローカル IP の controller 権限は維持されている）。
- [ ] **ログイン** → **ページをリロードせずに DJ ボタンが出る**。
- [ ] DJ ボタンを押す → **パネルに名前入力欄が無く、「DJ: <自分のニックネーム>」と表示されている**。
- [ ] submit → 生成された曲のタイトルと DJ 表示が**自分のニックネーム**になっている。
- [ ] **別のブラウザ（ログアウト状態）でも** DJ 名が同じニックネームで見えている。
- [ ] **ログアウト** → DJ ボタンが即座に消える。
- [ ] **promotion バグの回帰テスト**: ローカルでブラウザを2つ開き**両方ログイン**。controller のタブを閉じる → 昇格したタブが **DJ ボタンを保持している**（従来はここで消えていた）。
- [ ] `curl -si http://localhost:5555/api/library/index` が **401** を返す（無認証でライブラリが取れない）。
- [ ] ラジオ全体が今まで通り安定して鳴り続ける（数曲分放置して確認）。

**この PR がマージされた時点で Web 側は完成。ここからモバイルに移る。**

---

### PR 5 — `fix/mobile-offline-player-teardown`（P0 二重再生バグ）

`teardownPlayer` ヘルパー + 4箇所の置換（[:517](mobile/src/hooks/useRadio.ts#L517), [:723](mobile/src/hooks/useRadio.ts#L723), [:1192](mobile/src/hooks/useRadio.ts#L1192), [:1238](mobile/src/hooks/useRadio.ts#L1238)）+ `playOfflineTrack`/`enterOfflineMode` の準備チェック順序修正。**それだけ。**

> ネイティブモジュールの追加が無いので Expo の開発ビルドで検証可能。

**👤 人による受け入れテスト（マージ条件）**
- [ ] **バグ再現手順**: アプリ起動 → オンライン曲が鳴っている状態にする → Offline Mode → 5曲ダウンロード → オフラインに入る → **ヘッドホンで30秒聴く**。**音が1つだけ**（修正前は2つ重なっていた）。
- [ ] 同じ手順を、ダウンロード後に**機内モード**にしてから実行 → やはり音は1つだけ。
- [ ] 「PLAY EXISTING TRACKS」からオフラインに入った場合も音は1つだけ。
- [ ] 逆方向（Back to Online Mode）が今まで通り正常（回帰していない）。
- [ ] オフライン再生中に曲が終わって次の曲に進む時も音は1つだけ。
- [ ] ロック画面のコントロール（再生/一時停止/シーク）が正常に動く。
- [ ] バックグラウンドに回しても再生が続く（iOS / Android 両方）。

---

### PR 6 — `fix/mobile-offline-integrity-and-ux`（P1 + P2 をまとめる）

ステージングディレクトリ + 成功時スワップ + manifest、空き容量見積もり、サイドカーを try/catch 内に、リトライ前の部分ファイル削除、`dropOfflineTrack` のインデックス、`enterOfflineMode` の冪等性 + ダウンロードキャンセル、`exitOfflineMode` の到達性チェック、iOS バックグラウンドの duration フォールバック、`existingCount` の `finally` 更新、`indexError`/`downloadError` の分離、`enabled` フラグチェック、fetch タイムアウト、自己削除不変条件のコード化、再起動をまたぐオフラインモード永続化、`get_meta()` 削除 + `/api/library/index` の ETag。

> P1 と P2 を分けると人手テストの往復が2回になるので1本にまとめる。項目数は多いが、テストシナリオは重複する。

**👤 人による受け入れテスト（マージ条件）**
- [ ] **既存ライブラリの保護**: 5曲ダウンロード済みの状態で、機内モードにしてから DOWNLOAD を押す → 失敗するが、**「PLAY EXISTING TRACKS (5)」が正しく5と表示され、実際に5曲再生できる**（修正前は全消失していた）。
- [ ] **ダウンロード中の強制終了（Android）**: ダウンロード中にアプリを kill → 再起動 → 以前のライブラリが無傷で、孤児ファイルも残っていない。
- [ ] **機内モードでの退出拒否**: オフライン再生中に機内モードのまま「Back to Online Mode」→ **「まだオフラインです」と表示され、オフラインのまま曲も保持される**（修正前は全状態が消えて無限リトライになっていた）。
- [ ] **破損ファイル**: `tracks/<id>.mp3` を壊す → 再生時にその1曲だけスキップされる（2曲飛ばない）。
- [ ] **エラー表示**: ダウンロード失敗後にキーワードやジャンルを変更 → **エラーが消えて「Found N tracks」が再表示される**（修正前はエラーが出っぱなしだった）。
- [ ] **容量不足メッセージ**: 必要量と空き容量の両方が具体的に表示される。
- [ ] **再起動をまたぐ永続化**: オフライン再生中にアプリを完全終了 → **機内モードのまま**再起動 → **オフラインモードで直接立ち上がる**（修正前はオンライン接続を延々リトライしていた）。
- [ ] **パネルの体感速度**: 500曲ダウンロード済みで Offline Mode パネルを開く → 一瞬で開く（同期スキャンが manifest に置き換わっている）。
- [ ] **iOS バックグラウンド**: オフライン再生中に画面をロックして5分放置 → 曲が続けて進む。
- [ ] ライブラリのボリュームが未マウントの場合、「Found 0 tracks」ではなく**理由が分かるメッセージ**が出る（サーバ側で確認できれば）。

---

### PR 7 — `feat/mobile-auth-ui`（モバイルのログイン + DJ/オフラインの会員限定化）

`expo-secure-store` 追加、`mobile/src/hooks/useAuth.ts`、`mobile/src/components/AuthModal.tsx`（`OfflinePanel.tsx` を構造的に踏襲、`theme.ts` のトークンを使用）、`config.ts` の `wsUrl(token)` 化 + **`?client=mobile` 削除**、全 REST 呼び出しに Bearer ヘッダ、**`role_assigned` ハンドラの新規追加**（モバイルには現状1つも無い）、Offline/DJ ボタンを `isAuthenticated` でゲート、library fetch に Bearer、**モバイル `DJPanel.tsx` から DJ 名欄削除**、`app.json` を 1.6.0 / build 6 に。

> **ネイティブモジュール追加のため再ビルドが必要。** この PR のマージ後にストア申請する。

**👤 人による受け入れテスト（マージ条件）**
- [ ] **ログアウト状態**: アプリ起動 → ラジオは鳴る。**DJ ボタンも Offline Mode ボタンも無い**。「ログイン」ボタンがある。
- [ ] **サインアップ**: 招待コードでモバイルから新規登録できる。Web と同じバリデーションエラーが出る。
- [ ] **既存アカウントでログイン**できる。
- [ ] **アプリを完全終了して再起動してもログイン状態が保たれる**（SecureStore）。
- [ ] ログイン直後、**アプリを再起動せずに DJ ボタンと Offline Mode ボタンが出る**。
- [ ] **DJ**: パネルに名前欄が無く「DJ: <ニックネーム>」表示 → submit → 曲の DJ 名がニックネームになる。Web の別ブラウザからも同じ名前で見える。
- [ ] **オフライン**: ダウンロードが成功する（Bearer ヘッダが効いている）。
- [ ] **ログアウト** → DJ / Offline Mode ボタンが消える。
- [ ] **オフライン中のログアウト**: オフライン再生中にログアウト → **再生は止まらず、ダウンロード済みファイルも消えない**。「Back to Online Mode」すると匿名リスナーとしてオンラインに戻り、DJ/Offline ボタンは無い。
- [ ] **Web の DJ とモバイルの DJ が同じ枠を奪い合う**（片方が DJ 中はもう片方が claim できない）。
- [ ] ロック画面・バックグラウンド再生が今まで通り動く。
- [ ] **iOS と Android の両方**で上記を確認。

---

### PR 8 —（任意）`feat/auth-followups`

`release()` の調査、`?token=` を置き換える接続後 auth フレーム、library-audio のユーザー単位レート制限、`backend/scripts/create_user.py` CLI。

**追加（2026-09-08 に実際に発生した障害）— `uv run --frozen` で外部障害に耐えるようにする**

`scripts/start_prod.sh:99` は ACE-Step を `uv run acestep-api` で起動している。`uv run` は起動のたびにロックファイルを検証し、**直接 URL で指定された依存はメタデータを取得しにいく**。ACE-Step の `uv.lock` には Windows 専用の `flash-attn` wheel が直接 URL で入っており（`sys_platform == 'win32'` マーカー付きなので macOS では決してインストールされない）、その GitHub Releases URL が一時的に 500 を返した結果、**ロック検証ごと失敗して ACE-Step が起動できず、ラジオ全体が上がらなかった**。

```
error: Failed to generate package metadata for `flash-attn==2.8.2 @ direct+https://github.com/sdbds/...win_amd64.whl`
  Caused by: HTTP status server error (500 Internal Server Error)
```

つまり **Mac で動かしているのに、Windows 用 wheel をホストする外部サーバが単一障害点になっている**。

修正案: `uv run` → `uv run --frozen`（`scripts/start.sh` と `scripts/start_prod.sh` の両方）。ロック検証をスキップして既存の `.venv` をそのまま使うため、この経路の外部障害に耐えられる。`.venv` の更新は `scripts/setup.sh` の `uv sync` が担っている（既にそうなっている）ので、責務の分離としても素直。

トレードオフ: ACE-Step 側で依存が変わっても起動時に自動追従しなくなり、`setup.sh` を回すまで気づかない。実運用では `setup.sh` 経由で更新しているため実害は小さい。

---

### 順序制約のまとめ

```
PR1 (共通型) → PR2 (認証API) → PR3 (Web UI) → PR4 (DJゲート)   ← ここまでで Web 完成
                                                    ↓
                              PR5 (P0修正) → PR6 (オフライン堅牢化) → PR7 (モバイル認証)
                                                                        ↓
                                                                   ストア申請
```

各 PR は独立して revert 可能。PR 5 と 6 は認証と依存が無いので、もし Web の作業が詰まったら順序を入れ替えても構わない。

---

## 実装対象の主要ファイル

- [backend/main.py](backend/main.py) — WS トークン抽出、`include_router`、`/api/library/*` の `Depends`、`dj_submit` から `dj_name` を削除
- [backend/radio.py](backend/radio.py) — `add_ws` の身元保持、`_role_assigned_message`（[:709-712](backend/radio.py#L709-L712) のバグ修正）、[`claim_dj_from_ws:1476`](backend/radio.py#L1476)、[`submit_dj_from_ws:1502`](backend/radio.py#L1502)
- [backend/config.py](backend/config.py) — dotenv 読み込みの唯一の設置場所（`main.py`/`models.py`/`radio.py` が全て import するため）
- [mobile/src/hooks/useRadio.ts](mobile/src/hooks/useRadio.ts) — `teardownPlayer`（P0 修正: [:517](mobile/src/hooks/useRadio.ts#L517), [:723](mobile/src/hooks/useRadio.ts#L723), [:1192](mobile/src/hooks/useRadio.ts#L1192), [:1238](mobile/src/hooks/useRadio.ts#L1238)）、欠落している `role_assigned` ハンドラ、[`dropOfflineTrack:506`](mobile/src/hooks/useRadio.ts#L506)、[`enterOfflineMode:1202`](mobile/src/hooks/useRadio.ts#L1202) / [`exitOfflineMode:1233`](mobile/src/hooks/useRadio.ts#L1233)
- [mobile/src/utils/offlineLibrary.ts](mobile/src/utils/offlineLibrary.ts) — ステージングスワップ、空き容量見積もり、[:189](mobile/src/utils/offlineLibrary.ts#L189) の try/catch、[:173](mobile/src/utils/offlineLibrary.ts#L173) のリトライ前削除、Bearer ヘッダ、[:54](mobile/src/utils/offlineLibrary.ts#L54) の `enabled` チェック
- [packages/shared/src/types.ts](packages/shared/src/types.ts) — Web を先に繋ぎ込む共通契約（PR 0）、`RoleAssignedData.nickname` と `DjClaimAckData.reason`
- [mobile/src/config.ts](mobile/src/config.ts) — `WS_URL` 定数の関数化と `?client=mobile` 削除
