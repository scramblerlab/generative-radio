"""Client-IP resolution shared by the HTTP and WebSocket layers.

These helpers used to live in radio.py (WebSocket flavour) and main.py (HTTP
flavour) as near-identical copies. They are here so the auth router can key its
rate limiter on the real client IP without importing main.py — main.py builds
the OllamaClient / ACEStepClient / RadioOrchestrator singletons at import time,
which would make the router impossible to test in isolation.
"""

import ipaddress

from fastapi import Request, WebSocket


def normalize_ip(raw: str) -> str:
    """Convert IPv6-mapped IPv4 addresses to plain IPv4 strings.

    FastAPI/uvicorn may report:
      ::1               → 127.0.0.1   (IPv6 loopback)
      ::ffff:192.168.x.y → 192.168.x.y (IPv6-mapped IPv4)
    All other values are returned unchanged.
    """
    if raw == "::1":
        return "127.0.0.1"
    if raw.startswith("::ffff:"):
        candidate = raw[7:]
        # Accept only if it looks like a dotted-quad IPv4
        parts = candidate.split(".")
        if len(parts) == 4 and all(p.isdigit() for p in parts):
            return candidate
    return raw


def is_local_ip(ip: str) -> bool:
    """Return True if the IP is a loopback or private (RFC 1918 / ULA) address."""
    try:
        addr = ipaddress.ip_address(ip)
        return addr.is_loopback or addr.is_private
    except ValueError:
        return False


def _resolve(headers, client_host: str | None) -> str:
    """Shared body of the two resolvers below.

    When served behind Cloudflare Tunnel the socket peer is always 127.0.0.1
    (the local cloudflared process). Cloudflare injects CF-Connecting-IP with the
    actual visitor's IP, which is what lets us tell local from remote clients.
    """
    cf_ip = headers.get("cf-connecting-ip", "").strip()
    if cf_ip:
        return normalize_ip(cf_ip)
    forwarded = headers.get("x-forwarded-for", "").strip()
    if forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return normalize_ip(first)
    return normalize_ip(client_host) if client_host else "unknown"


def resolve_request_ip(request: Request) -> str:
    """Resolve the real client IP from an HTTP request, honoring proxy/CDN headers."""
    return _resolve(request.headers, request.client.host if request.client else None)


def resolve_client_ip(ws: WebSocket) -> str:
    """Resolve the real client IP from a WebSocket upgrade, honoring proxy/CDN headers."""
    return _resolve(ws.headers, ws.client.host if ws.client else None)
