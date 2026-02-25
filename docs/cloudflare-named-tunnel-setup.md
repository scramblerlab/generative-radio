# Cloudflare Named Tunnel: Fixed Domain Setup

> **Date:** 2026-02-25
> **Status:** Feasible — pending one-time setup on production machine
> **Target URL:** `https://radio.scrambler-lab.com`
> **References:**
> - [Cloudflare: Create a locally-managed tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/)
> - [Cloudflare: Run as a service on macOS](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/macos/)
> - [Cloudflare: WebSocket protocols](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)

---

## Current State

`start.sh` uses a **Quick Tunnel**:

```bash
cloudflared tunnel --url http://localhost:5173
```

This generates a random `*.trycloudflare.com` URL each startup. The URL changes every time and cannot be bookmarked or shared permanently.

## Goal

Replace with a **Named Tunnel** that permanently maps `radio.scrambler-lab.com` to `localhost:5173` on the production Mac Mini. The URL stays the same across restarts.

## Prerequisites

- `scrambler-lab.com` is already connected to Cloudflare's DNS servers (confirmed)
- `cloudflared` is already installed via Homebrew

## Feasibility

**Fully feasible.** Named Tunnels are free, support WebSocket connections natively (no special config needed), and the DNS setup is a one-time step. The only requirement is running `cloudflared tunnel login` once on the production machine to authenticate.

---

## One-Time Setup (Run on Production Mac Mini)

### Step 1: Authenticate cloudflared

```bash
cloudflared tunnel login
```

Opens a browser. Log in to Cloudflare, select the `scrambler-lab.com` zone. A `cert.pem` file is saved to `~/.cloudflared/`.

### Step 2: Create a named tunnel

```bash
cloudflared tunnel create generative-radio
```

Outputs a UUID (e.g., `a1b2c3d4-e5f6-7890-abcd-ef1234567890`) and creates `~/.cloudflared/<UUID>.json` (credentials file). Note the UUID.

### Step 3: Route DNS

```bash
cloudflared tunnel route dns generative-radio radio.scrambler-lab.com
```

This automatically creates a CNAME record in Cloudflare DNS:

```
radio.scrambler-lab.com  →  <UUID>.cfargotunnel.com
```

Verify in the Cloudflare dashboard under DNS for `scrambler-lab.com`.

### Step 4: Create config file

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <UUID>
credentials-file: /Users/<username>/.cloudflared/<UUID>.json

ingress:
  - hostname: radio.scrambler-lab.com
    service: http://localhost:5173
  - service: http_status:404
```

The catch-all `http_status:404` rule is required by cloudflared.

### Step 5: Verify

```bash
cloudflared tunnel run generative-radio
```

Open `https://radio.scrambler-lab.com` from any device. If it works, kill the test run (Ctrl+C).

---

## Script Changes (`start.sh`)

The tunnel section changes from the current Quick Tunnel:

```bash
cloudflared tunnel --url http://localhost:5173
```

To a Named Tunnel with Quick Tunnel fallback:

```bash
if [ -f "$HOME/.cloudflared/config.yml" ]; then
    # Named tunnel — permanent URL
    cloudflared tunnel run generative-radio > /tmp/generative-radio-cloudflared.log 2>&1 &
    CLOUDFLARED_PID=$!
    TUNNEL_URL="https://radio.scrambler-lab.com"
else
    # Quick tunnel fallback — random URL (for dev machines without named tunnel setup)
    cloudflared tunnel --url http://localhost:5173 > /tmp/generative-radio-cloudflared.log 2>&1 &
    CLOUDFLARED_PID=$!
    # ... existing grep logic for random URL ...
fi
```

The startup banner can show the fixed URL when the named tunnel is active. No URL grep is needed since the URL is always `https://radio.scrambler-lab.com`.

---

## Optional: Run as macOS Launch Agent (Permanent Service)

If you want the tunnel to survive reboots and run independently of `start.sh`:

```bash
sudo cloudflared service install
sudo launchctl start com.cloudflare.cloudflared
```

Logs go to `/Library/Logs/com.cloudflare.cloudflared.err.log` and `.out.log`.

If running as a service, `start.sh` can skip the tunnel step entirely when the service is already running. Check with:

```bash
if launchctl list | grep -q com.cloudflare.cloudflared; then
    echo "Cloudflare tunnel running as system service"
    TUNNEL_URL="https://radio.scrambler-lab.com"
else
    # start tunnel manually ...
fi
```

To restart after config changes:

```bash
sudo launchctl stop com.cloudflare.cloudflared
sudo launchctl start com.cloudflare.cloudflared
```

---

## Comparison

| Aspect | Current (Quick Tunnel) | Named Tunnel |
|---|---|---|
| URL | Random `*.trycloudflare.com` | Fixed `radio.scrambler-lab.com` |
| Persists across restarts | No | Yes |
| DNS setup | None | One-time `cloudflared tunnel route dns` |
| WebSocket support | Automatic | Automatic |
| Config needed | None | `~/.cloudflared/config.yml` (one-time) |
| Auth needed | None | `cloudflared tunnel login` (one-time) |
| Cost | Free | Free |
| Script change | N/A | Replace `--url` with `tunnel run`, add fallback |

---

## WebSocket Note

Cloudflare Tunnel proxies WebSocket connections natively when the service is defined as `http://`. No special configuration is needed. The app's `/ws` WebSocket endpoint will work through `radio.scrambler-lab.com` exactly as it does through the Quick Tunnel today.
