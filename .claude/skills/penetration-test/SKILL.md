---
name: penetration-test
description: Black-box web application penetration test — enumerate, exploit, fix, re-test, and report. Covers OWASP Top 10 2025, API Security Top 10 2023, JWT, WebSocket, cloud metadata, LLM threats, and more. Attack patterns auto-refresh every 30 days.
argument-hint: <target-url>
---

# Penetration Test Skill

**Target:** $ARGUMENTS

The attack test patterns live in a separate file. Read it now before proceeding:
`.claude/skills/penetration-test/patterns.md` (project-local install)
`~/.claude/skills/penetration-test/patterns.md` (global install)
Try both paths and use whichever exists.

---

## Phase 0 — Pattern Freshness Check

The date is stored directly in `patterns.md` as a line matching `*last_patterns_updated: YYYY-MM-DD*`. Parse it from the file you already read and compare to today's date.

Calculate how many days have passed since `last_patterns_updated` and ask the user:

> "Pattern file is **N days old** (last updated: DATE).
> Would you like to:
> 1. Use existing patterns and proceed  *(default — press Enter)*
> 2. Update patterns now before testing"

Wait for the reply. Treat an empty reply or "1" as option 1.

- **Option 1 (or < 30 days old and user pressed Enter):** announce "Using existing patterns. Proceeding." → skip to Phase 1.
- **Option 2, or patterns are ≥ 30 days old and user chose to update:** announce "Updating pattern catalogue…" Then:
  1. Derive year variables from today's date:
     - CURRENT_YEAR = current 4-digit year (e.g. 2027)
     - PREV_YEAR = CURRENT_YEAR − 1
  2. Run these WebSearch queries (substitute the actual year values):
     - `OWASP Top 10 PREV_YEAR CURRENT_YEAR new vulnerability categories site:owasp.org`
     - `OWASP API Security Top 10 PREV_YEAR CURRENT_YEAR latest attack techniques site:owasp.org`
     - `web application high severity CVE PREV_YEAR CURRENT_YEAR new attack vectors site:cve.mitre.org OR site:portswigger.net`
     - `LLM AI application security vulnerabilities PREV_YEAR CURRENT_YEAR site:owasp.org OR site:portswigger.net`
     - `new web application attack classes PREV_YEAR CURRENT_YEAR site:owasp.org OR site:portswigger.net OR site:cve.mitre.org`
  3. Identify new attack classes not already in `patterns.md`.
  4. Use Edit to add new findings into the relevant sections of `patterns.md`. Do NOT remove existing entries — only add or update.
  5. Use Edit to update both the `last_patterns_updated` date line and the `patterns_catalogue_version` year in `patterns.md` to reflect today.
  6. Announce "Pattern catalogue updated to CURRENT_YEAR. Proceeding."

> **Note:** If `last_patterns_updated` is missing entirely, skip the question and run the update automatically.

---

## Phase 1 — Target Confirmation

If `$ARGUMENTS` is empty, ask the user:
> "Please provide the target URL to test (e.g. https://example.com):"

Wait for the reply. Use their answer as TARGET for all subsequent phases.

Otherwise set TARGET = `$ARGUMENTS`.

Confirm with the user:
- Single domain, or subdomains / specific paths too?
- Any area to prioritise (API security, auth, headers, etc.)?

Proceed with reasonable defaults if the user says "go ahead".

---

## Phase 2 — Reconnaissance

Collect baseline evidence. Record all raw responses verbatim for the report.

```bash
# HTTP response headers — server identity, security headers
curl -sI TARGET

# Technology fingerprinting
curl -s TARGET | grep -iE "x-powered-by|generator|framework|version"

# Security headers — check for presence/absence of:
#   Strict-Transport-Security, Content-Security-Policy, X-Frame-Options,
#   X-Content-Type-Options, Permissions-Policy, Cross-Origin-Opener-Policy,
#   Cross-Origin-Embedder-Policy, Cross-Origin-Resource-Policy, Referrer-Policy
```

---

## Phase 3 — Endpoint Enumeration

Probe common paths to map the attack surface. Record HTTP status for each.

```bash
for path in /api /api/v1 /api/v2 /graphql /health /status /debug \
            /docs /openapi.json /redoc /swagger /swagger-ui.html \
            /admin /metrics /actuator /actuator/env /actuator/health \
            /.env /.git/HEAD /config /server-status /robots.txt /sitemap.xml; do
  echo -n "$path: "
  curl -so /dev/null -w "%{http_code}" TARGET$path
  echo
done
```

Note which paths return 200 (check body — may be SPA fallback), 401/403 (protected), or 404.

Identify API style: REST, GraphQL, WebSocket.

---

## Phase 4 — Vulnerability Testing

Using the patterns loaded from `patterns.md`, run all applicable sections. Skip sections with no relevant surface (e.g. no GraphQL endpoint → skip Section 8). For each test:
- Run the command
- Record HTTP status + first 300 chars of response body
- Classify: 🔴 CRITICAL / 🟠 HIGH / 🟡 MEDIUM / 🔵 LOW / ✅ Not vulnerable

> **Important:** When a path returns HTTP 200 for generic paths (/.env, /.git/HEAD, etc.), always inspect the response body — a React/Vue SPA will return index.html for all unmatched routes, which is a false positive.

---

## Phase 4.5 — Post-Test Decision

Present a findings summary table (ID, category, severity, one-line description). Then ask:

> **Testing complete. What would you like to do next?**
>
> 1. **Generate report now** — write the report with findings as-is (no fixes).
> 2. **Fix, re-test, and report** — fix all CRITICAL and HIGH findings, re-test, then write a full BEFORE/AFTER report.
> 3. **Something else** — describe what you'd like (e.g. "fix only the CORS issue", "export as JSON", "explain how to fix finding #3", "just summarise the risks", "finish without a report").

- **Option 1:** go to Phase 7 directly.
- **Option 2:** Phase 5 → Phase 6 → Phase 7.
- **Option 3:** accommodate the request using best judgement; confirm before any irreversible action (modifying source files, writing reports).

---

## Phase 5 — Fix Vulnerabilities

For each CRITICAL and HIGH finding:

1. Use `Read` and `Grep` to locate the relevant source file and line.
2. Apply the minimal targeted fix:

| Finding | Generic Fix |
|---------|------------|
| Missing security headers | `helmet` (Node); FastAPI: `from starlette.middleware.base import BaseHTTPMiddleware` (**not** `fastapi.middleware.base`); Vite: `server.headers` + `preview.headers` in `vite.config.ts`; or Cloudflare Transform Rules |
| CORS wildcard | Replace `allow_origins=["*"]` with explicit list; regex only for known patterns |
| JWT none-alg | Enforce algorithm allowlist; reject `alg: none` |
| Unauthenticated endpoint | Add auth dependency/guard to route |
| BOLA (ID enumeration) | Validate ownership server-side before returning data |
| Path traversal | Resolve path; verify it stays within allowed root |
| SQLi | Parameterized queries only; no string interpolation |
| SSRF | Blocklist RFC 1918 + cloud metadata IPs; use host allowlist |
| Debug endpoint exposed | Disable via env flag in production; gate behind auth |
| Rate limiting absent | Per-IP limiter on auth endpoints (e.g. `slowapi`, `express-rate-limit`) |
| CSWSH | Validate `Origin` header in WebSocket upgrade handler |

3. Check if a server restart is needed after edits.

---

## Phase 6 — Re-test (AFTER)

Repeat each Phase 4 command that found a vulnerability:
- Record new HTTP status and response body
- Confirm fix is effective
- Confirm legitimate access still works

---

## Phase 7 — Report

Write to:
- **Inside a project:** `{project-root}/penetration-test-report-{hostname}-{YYYY-MM-DD}.md`
- **Otherwise:** `./penetration-test-report-{hostname}-{YYYY-MM-DD}.md`

Structure:
1. Executive Summary (findings table)
2. Target & Scope
3. Methodology
4. Findings — BEFORE (description, evidence, impact, root cause per finding)
5. Fixes Applied (before/after diffs)
6. Findings — AFTER (re-test evidence)
7. Residual Risk
8. Recommendations
