# cursor-api-proxy — Wiki

**cursor-api-proxy** is a small **Node.js / TypeScript** service: an **OpenAI-compatible HTTP API** (plus Anthropic-style `POST /v1/messages`) that forwards chat to **Cursor’s CLI agent** (`cursor-agent` / ACP). It is the evolution of the older single-file **claude-cursor-bridge** pattern, packaged for `npm` and richer options (TLS, account pool, strict models, etc.).

This page documents the **local dashboard**, **markdown wiki in the browser**, and the **`cursor-api-proxy` shell launcher** — the same trio as **claude-cursor-bridge**.

---

## Table of contents

1. [What you get in the browser](#what-you-get-in-the-browser)
2. [Quick start](#quick-start)
3. [The `cursor-api-proxy` CLI launcher](#the-cursor-api-proxy-cli-launcher)
4. [Install the launcher script](#install-the-launcher-script)
5. [Auto-start at login (macOS launchd)](#auto-start-at-login-macos-launchd)
6. [HTTP routes](#http-routes)
7. [Files & directories](#files--directories)
8. [Troubleshooting](#troubleshooting)

---

## What you get in the browser

With the proxy **running**, open:

| URL | Purpose |
|-----|---------|
| `http://127.0.0.1:8765/` | **Dashboard** — React single-page app with a sidebar: Overview, Requests, Logs, Accounts, Config, Diagnostics, Wiki, Settings |
| `http://127.0.0.1:8765/wiki` | **Wiki** — the same app, opened on the Wiki route, rendering `docs/WIKI.md` |
| `http://127.0.0.1:8765/accounts` | JSON list of saved Cursor accounts (auth method, email, plan/usage when available) |
| `http://127.0.0.1:8765/healthz` | Plain **`ok`** (for scripts and load checks) |
| `http://127.0.0.1:8765/metrics` | **Prometheus** text exposition (loopback-only unless `CURSOR_BRIDGE_API_KEY` is set) |
| `http://127.0.0.1:8765/health` | JSON health payload (version, workspace, default model, …) |

Port **`8765`** is the default (`CURSOR_BRIDGE_PORT`). Host defaults to **`127.0.0.1`** (`CURSOR_BRIDGE_HOST`).

The app shell and its assets load without a key. When `CURSOR_BRIDGE_API_KEY` is set, mutating `/api/*` routes and sensitive reads (`/api/accounts`, `/api/config`, `/api/doctor`, `/api/requests`) require `Authorization: Bearer <CURSOR_BRIDGE_API_KEY>`. Paste that value into **Settings → Dashboard key** (stored in `sessionStorage` for the tab). If the key is unset, mutations are allowed only from loopback (`127.0.0.1` / `::1`). Keep the service on loopback in production.

Navigation is hash based (`/#/accounts`, `/#/logs`, …), so `GET /` and `GET /wiki` are the only HTML entry points the server has to serve. **Settings** also holds the light/dark theme toggle (persisted in `localStorage`) and the per-page polling intervals.

---

## Quick start

```bash
cd /path/to/cursor-api-proxy
npm install
npm run build   # dashboard (Vite → public/dashboard/) + server (tsc → dist/)

# Foreground (see stdout):
npm start

# Or use the launcher (after [install](#install-the-launcher-script)):
cursor-api-proxy start
cursor-api-proxy health
```

Then open the dashboard at `http://127.0.0.1:8765/` (or your configured host/port).

---

## The `cursor-api-proxy` CLI launcher

Same idea as **claude-cursor-bridge**’s `claude-bridge`: a **bash** script in `~/.local/bin/cursor-api-proxy` that can start/stop the Node process, probe **`/healthz`**, and optionally install a **launchd** plist.

| Command | Behavior |
|---------|----------|
| `cursor-api-proxy` | No args: print **health**, then a tiny interactive menu |
| `cursor-api-proxy start` | Background start, append stdout/stderr to `~/.cursor-api-proxy/proxy.log`, wait for `/healthz` |
| `cursor-api-proxy stop` | `SIGTERM`, then `SIGKILL` if needed |
| `cursor-api-proxy restart` | `stop` then `start` |
| `cursor-api-proxy health` | PID, port, launchd state, HTTP probe, last log lines |
| `cursor-api-proxy requests` | Formatted latest completed requests from `sessions.log` |
| `cursor-api-proxy enable` | Write `~/Library/LaunchAgents/com.cursor-api-proxy.plist` and `launchctl load` |
| `cursor-api-proxy disable` | `launchctl unload` and remove the plist |
| `cursor-api-proxy run` | Foreground `node …/dist/cli.js` (what launchd invokes) |

Request viewer options:

```bash
cursor-api-proxy requests --limit 50
cursor-api-proxy requests --watch --interval 1
```

The viewer reads `CURSOR_BRIDGE_SESSIONS_LOG` directly (default
`~/.cursor-api-proxy/sessions.log`), including while the proxy is stopped.
`NO_COLOR=1` disables ANSI colors.

Environment the script honors:

| Variable | Meaning |
|----------|---------|
| `CURSOR_API_PROXY_ROOT` | Path to the **git checkout** (must contain `dist/cli.js` after `npm run build`) |
| `CURSOR_BRIDGE_PORT` | HTTP port (default **8765**) |
| `CURSOR_BRIDGE_HOST` | Bind address (default **127.0.0.1**) |

---

## Install the launcher script

From your clone:

```bash
chmod +x scripts/cursor-api-proxy
mkdir -p ~/.local/bin
ln -sf "$(pwd)/scripts/cursor-api-proxy" ~/.local/bin/cursor-api-proxy
export CURSOR_API_PROXY_ROOT="$(pwd)"   # add to ~/.zshrc if you want it permanent
cursor-api-proxy health
```

If you installed the package globally with npm instead of a clone, point `CURSOR_API_PROXY_ROOT` at the package directory that contains `dist/cli.js` (for example under `$(npm root -g)/cursor-api-proxy`).

---

## Auto-start at login (macOS launchd)

```bash
cursor-api-proxy enable
launchctl list | grep cursor-api-proxy
```

The plist label is **`com.cursor-api-proxy`**. Use **`cursor-api-proxy disable`** before **`stop`** if you want the process to stay stopped (otherwise **KeepAlive** may respawn it).

---

## HTTP routes

**LLM / health / accounts**

- `GET /health`, `GET /healthz`, `GET /v1/models`
- `GET /metrics` — Prometheus text format (`text/plain; version=0.0.4`). Bearer when `CURSOR_BRIDGE_API_KEY` is set, loopback-only otherwise, **404** when `CURSOR_BRIDGE_METRICS_ENABLED=false`. Exposes `cursor_proxy_requests_total`, `cursor_proxy_request_duration_seconds`, `cursor_proxy_span_duration_seconds` (latency waterfall), `cursor_proxy_admission_in_use` / `_limit`, `cursor_proxy_account_state`, `cursor_proxy_failover_total`, `cursor_proxy_rate_limited_total`, `cursor_proxy_build_info`
- `GET /accounts` — JSON account pool listing (same data as `cursor-api-proxy accounts`; dashboard table uses `/api/accounts`)
- `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages`

**Dashboard**

- `GET /` and `GET /wiki` both serve `public/dashboard/index.html`; `GET /static/*` serves `public/*`, so bundles resolve at `/static/dashboard/assets/…` (always open)
- `GET /api/status`, `GET /api/log`, `GET /api/stats`, `GET /api/wiki`
- Sensitive reads (Bearer when `CURSOR_BRIDGE_API_KEY` is set): `GET /api/config`, `GET /api/accounts`, `GET /api/doctor`, `GET /api/requests?limit=`
- `GET /api/requests` returns `{ path, source, requests }`. With the structured log enabled (`source: "jsonl"`) each entry carries `durationMs`, `model`, `engine`, `account`, `streaming`, `errorCode`, `failoverCount`, `spans` and prompt/completion character counts; the **Requests** page opens any row for the latency waterfall and the raw record. Without it (`source: "text"`) entries are the four fields parsed from `sessions.log`.
- Mutations (Bearer when key set; else loopback only):
  - `POST /api/control` `{ "action": "start" | "stop" | "restart" | "enable" | "disable" }`
  - `POST /api/log/clear`
  - `POST /api/accounts` `{ "name", "apiKey" }` — API-key account add (reuses `saveApiKeyAccount`)
  - `PUT /api/accounts/:name/key` `{ "apiKey" }` — attach key to existing account
  - `DELETE /api/accounts/:name` — remove account directory
  - `POST /api/reset-hwid` `{ "deepClean"?: boolean }` — destructive Cursor HWID reset
- Interactive browser login is **not** exposed over HTTP; use CLI `cursor-api-proxy login`.
- Responses never include raw API keys. Auth badges: `API key`, `CLI`, or `CLI + key` when a session account also has `.cursor-api-key`.
- `GET /api/config` exposes real admission caps (`maxConcurrentRuns*`, `sdkMaxConcurrentRuns*`, `admissionWaitMs`) without secrets.

**`GET /accounts` notes**

- Returns `{ "accounts": [ … ] }` with fields such as `name`, `authMethod`, `email`, `plan`, `usage`, `usageError`, `hasApiKey`.
- Agent API keys (`crsr_…`) can enrich email / key metadata via Cursor `GET /v1/me`. **Key-only** accounts keep plan/usage `null` (`usageError: "api_key_unsupported"`). A CLI/browser session JWT can coexist with `.cursor-api-key` on the same account dir (`set-key`); plan/usage then come from the session while the key remains available for key-based execution.

---

## Files & directories

| Path | Role |
|------|------|
| `dist/cli.js` | Compiled server entry |
| `web/` | Dashboard source (React + TypeScript; design system in `web/src/design-system/`) |
| `public/dashboard/` | Built dashboard assets — produced by `npm run build:web`, **committed** so npm/git installs need no frontend build |
| `docs/WIKI.md` | Wiki source |
| `scripts/cursor-api-proxy` | Launcher script (symlink target) |
| `~/.cursor-api-proxy/sessions.log` | Default request log (one line per finished response) |
| `~/.cursor-api-proxy/requests.jsonl` | Structured request log (one JSON record per response; rotates to `.1`, see `CURSOR_BRIDGE_REQUESTS_LOG*`) |
| `~/.cursor-api-proxy/proxy.log` | Launcher / background stdout+stderr |
| `~/.cursor-api-proxy/proxy.pid` | Written by the running Node process for the dashboard |

---

## Troubleshooting

**`CLI not found` when using action buttons**

Install the launcher to `~/.local/bin/cursor-api-proxy` (see [install](#install-the-launcher-script)).

**Dashboard page is blank / 404 on `/`**

`GET /` serves `public/dashboard/index.html`. Those assets are committed, but if you deleted or never built them, run `npm run build:web` (or the full `npm run build`).

**`Started, but no health response`**

- Confirm `npm run build` was run so `dist/cli.js` exists.
- Check `CURSOR_API_PROXY_ROOT`.
- If port is in use, set `CURSOR_BRIDGE_PORT` to a free port in both the environment **and** the plist (re-run `enable` after editing the script or env).

**Dashboard shows “no requests”**

Stats are parsed from **`sessions.log`** lines in the form logged by the proxy (`ISO8601 METHOD PATH REMOTE STATUS`). If the log path was overridden (`CURSOR_BRIDGE_SESSIONS_LOG`), the dashboard reads that file instead. The **Requests** page prefers `requests.jsonl` and falls back to that text log, so a row without model/duration detail means the structured log is disabled or still empty.

**`/metrics` returns 401, 403 or 404**

- **401** — `CURSOR_BRIDGE_API_KEY` is set, so the scrape needs `Authorization: Bearer <key>`.
- **403** — no key is configured and the scrape came from a non-loopback address. Set a key (and scrape with it) or run Prometheus on the same host.
- **404** — `CURSOR_BRIDGE_METRICS_ENABLED=false`.

**`503` / admission capacity under parallel prompts**

ACP/CLI and SDK use **separate** admission planes. ACP defaults: **16** global / **2** per account. SDK defaults: **48** / **12** (`CURSOR_BRIDGE_MAX_CONCURRENT_RUNS*_SDK`). With few accounts the per-account cap is the usual bottleneck. Raise the matching plane only with headroom (RAM for ACP; rate limits / CPU for SDK), or add accounts. `GET /healthz` reports `admission.acp` and `admission.sdk`. See the README env table (**Admission tuning** note).

---

## Relation to claude-cursor-bridge

| Feature | claude-cursor-bridge | cursor-api-proxy |
|---------|---------------------|------------------|
| Anthropic → Cursor | yes | yes (+ OpenAI chat schema) |
| Local dashboard + wiki | yes | yes |
| Bash launcher + launchd | `claude-bridge` | `cursor-api-proxy` |
| npm package / TypeScript | no | yes |
