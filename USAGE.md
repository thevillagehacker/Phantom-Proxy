# PhantomProxy — Usage Guide (v2.3.0)

Complete reference for every feature. Use this document when publishing on GitHub or onboarding users.

---

## Table of contents

1. [Installation](#1-installation)
2. [Opening the tool](#2-opening-the-tool)
3. [Top bar & global controls](#3-top-bar--global-controls)
4. [Scope](#4-scope)
5. [Intercept (proxy hold)](#5-intercept-proxy-hold)
6. [History](#6-history)
7. [Repeater](#7-repeater)
8. [Tools](#8-tools)
   - [Sitemap](#81-sitemap)
   - [Search](#82-search)
   - [Compare](#83-compare)
   - [Match & replace](#84-match--replace)
   - [Intruder](#85-intruder)
   - [Parameter miner](#86-parameter-miner)
   - [Cookie jar](#87-cookie-jar)
   - [Issue board](#88-issue-board)
   - [WebSocket client](#89-websocket-client)
   - [JWT editor](#810-jwt-editor)
   - [Passive checks](#811-passive-checks)
   - [Project save / load](#812-project-save--load)
9. [Decoder](#9-decoder)
10. [Keyboard shortcuts](#10-keyboard-shortcuts)
11. [Security notes](#11-security-notes)
12. [Limitations](#12-limitations)

---

## 1. Installation

### Load unpacked (developer)

1. Clone or download this repository.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project root (folder containing `manifest.json`).
5. Pin the extension if you want the toolbar icon.

### Permissions

| Permission | Purpose |
|------------|---------|
| `webRequest` + host access | Passiveively capture HTTP(S) traffic |
| `storage` | Scope, notes, bookmarks, match/replace, issues |
| `cookies` | Cookie jar + Repeater cookie load |
| `debugger` | Full intercept (optional path) |
| `scripting` | Page-hook intercept fallback |
| `tabs` / `windows` | Standalone window + target tab |

---

## 2. Opening the tool

### DevTools panel

1. Open any `http://` or `https://` page.
2. Press **F12** (or right-click → Inspect).
3. Select the **PhantomProxy** tab.

Traffic is tied to the **inspected** tab.

### Standalone window

1. Click the extension icon.
2. Click **EXECUTE**.
3. Use **TARGET TAB** to choose which browser tab to monitor (or All Tabs).

Standalone is recommended for **Intercept (debugger mode)** and multi-monitor workflows.

---

## 3. Top bar & global controls

| Control | Action |
|---------|--------|
| **CAPTURING / PAUSED** | Pause stops adding new rows (history kept) |
| **SCOPE badge** | Shows scope on/off and domain count |
| **⬇ HAR / ⬆ HAR** | Export or import HAR 1.2 |
| **⬇ PROJECT / ⬆ PROJECT** | Full project JSON (history, scope, notes, rules) |
| **⌫ CLEAR** | Clear captured history |
| **⏸ PAUSE** | Toggle capture |
| **◎ INTERCEPT** | Toggle intercept on/off (same as Intercept tab) |

---

## 4. Scope

**Tab:** SCOPE  

Defines which **hosts/URLs** you care about. Complementary to Target Tab (standalone), which filters by browser tab.

### Patterns

| Input | Meaning |
|-------|---------|
| `example.com` | That host + subdomains |
| `*.example.com` | Wildcard host (includes apex) |
| `api-*.cdn.com` | Mid-string wildcards |
| `example.com/api/*` | Host + path pattern |
| `/regex/i` | Full JS regex (validated, length-capped) |

### Modes

- **SCOPE ON/OFF** — enable filtering.
- **MODE: DIM** — out-of-scope rows greyed out.
- **MODE: HIDE** — out-of-scope rows removed from the list.
- **ADD ALL FROM HISTORY** — pull unique hosts from current capture.

History also has **IN SCOPE ONLY** chip (works even if global SCOPE is OFF, as long as domains are listed).

---

## 5. Intercept (proxy hold)

**Tab:** INTERCEPT (between Scope and History)

Holds live requests so you can **edit → forward** or **drop**, Burp-style.

### Modes

| Mode | When | What is held |
|------|------|----------------|
| **Debugger** | Standalone + specific Target Tab (default) | Nearly all HTTP; browser may show “debugging this browser” banner |
| **Page hook** | DevTools panel (default), or **Prefer page hook** | `fetch()` and `XMLHttpRequest` only |

DevTools already uses the debugger on the inspected page, so PhantomProxy automatically prefers **page hook** there.

### Setup

1. **Standalone:** Target Tab = a real `https://…` tab (not “All Tabs”) → **INTERCEPT ON**.
2. **DevTools:** **INTERCEPT ON** → **reload the page** so hooks attach early.
3. Browse / trigger API calls.
4. Select a queue item, edit method/URL/headers/body if needed.
5. **▶ FORWARD** or **✕ DROP**.

### Options

| Option | Effect |
|--------|--------|
| **In-scope only** | Only hold URLs matching Scope domains |
| **+ Responses** | Also pause at response stage (debugger mode) |
| **Prefer page hook** | Force fetch/XHR hook even in Standalone |

### Keys

| Key | Action (when not typing in a field) |
|-----|--------------------------------------|
| **F** | Forward selected |
| **D** | Drop selected |

### POST / body handling (important)

- **Unedited Forward** re-issues the request **without rewriting the body** so original POST/PUT/PATCH payloads (including multipart/FormData) stay intact.
- Edited body/headers are applied carefully; `Content-Length` is recalculated when the body is overridden.
- GET/HEAD never send a body on forward.

### Buttons

| Button | Action |
|--------|--------|
| FORWARD | Send selected (with edits if any) |
| FORWARD ALL | Release entire queue |
| DROP | Block selected |
| DROP ALL | Block entire queue |

---

## 6. History

**Tab:** HISTORY  

Passive capture of requests (URL, method, headers, body when available, status, timing, type).

### Filters

- Text filter (URL substring)
- Method chips
- Status chips (2xx / 3xx / 4xx / 5xx / ERR)
- Type multi-select (XHR, document, image, …)
- **IN SCOPE ONLY**
- **HIGHLIGHTED ONLY** (bookmarks)

### Detail pane

- Request headers / body, response headers  
- **RES PRETTY** — re-fetch for pretty body  
- **RAW** — reconstructed request  
- **⟳ SEND TO REPEATER**  
- **⎘ COPY AS CURL**  
- **⚡ FUZZ** — open Intruder with this request  
- **CMP A / CMP B** — set Compare sides  
- Notes + tags bar (persisted)

### Bookmarks

Right-click a row → color + optional note. Persisted in storage.

### Flags

Automatic badges (JWT, AUTH, ADMIN, 403, GraphQL, …).

---

## 7. Repeater

**Tab:** REPEATER  

Edit and re-send any request (or craft one from scratch).

### Request editor

- Method + URL + **▶ SEND** (`Ctrl+Enter` in URL/body/raw)
- **HEADERS** — key/value rows  
- **COOKIES** — name/value pairs; **LOAD BROWSER COOKIES**  
- **BODY** — content-type + format JSON  
- **RAW HTTP** — full text edit  

### Actions

| Button | Action |
|--------|--------|
| **▶ SEND** | Fire via background worker (SSRF-guarded) |
| **⚡ FUZZ** | Send current editor state to Intruder |
| **⬆ IMPORT CURL** | Parse cURL into a new session |
| **CMP A / CMP B** | Store last response for Compare (on response bar) |

### Response

- Status / time / size  
- Body raw/pretty, response headers  
- Copy / wrap  

### Match & replace

Enabled rules from Tools → Match/Replace are applied on every send.

---

## 8. Tools

**Tab:** TOOLS — left sub-nav.

### 8.1 Sitemap

Host → path tree of captured traffic.

- Click path → jump to a sample request in History  
- **Right-click path → Send to Intruder**  
- Refresh rebuilds from current history  

### 8.2 Search

Global search across history:

- Fields: URL, request headers, body, response headers  
- Literal or regex (capped / ReDoS-guarded)  
- Click a hit to open History detail  

### 8.3 Compare

**Single comparer** for History and Repeater.

1. Set **A** and **B**:
   - History: **CMP A** / **CMP B** on the detail bar  
   - Repeater: **CMP A** / **CMP B** on the response bar after a response  
2. Open Tools → **COMPARE** → **COMPARE**.  
3. **CLEAR** resets both sides so you can compare again.

Diffs cover URL/status, request headers, request body, response headers, and response body when present.

### 8.4 Match & replace

Rules applied on Repeater and Intruder send.

- Targets: body, headers, URL, cookie  
- Literal or regex (safe compile)  
- Max 50 rules; persisted  

### 8.5 Intruder

Positions + payload sets + attack engine.

#### Positions

Place `§…§` markers in:

- URL  
- Headers (one `Name: value` per line)  
- Body  

**INSERT § §** wraps the selection in the focused field.

#### Attack modes

| Mode | Behavior |
|------|----------|
| **Sniper** | Each payload applied to **all** markers |
| **Pitchfork** | Payload set 1 → 1st marker, set 2 → 2nd, set 3 → 3rd (by index) |
| **Cluster bomb** | Cartesian product of sets (capped) |

#### Payload types

- Simple list (sets 1–3 for multi-position)  
- Numbers (from / to / step / base / pad)  
- Wordlist file (local, max 2MB, capped lines)  
- Brute / charset  
- Null payloads  
- Dates  
- Runtime file  

#### Processors

URL-encode, Base64, double URL-encode, prefix, suffix.

#### Results

- Table: #, payload, status, length, time  
- Click row → full **request / response / res headers**  
- **Grep** filter on results  
- **→ REPEATER**, copy req/res  

#### Limits

Max **500** payloads per attack (safety). Delay 50–5000 ms.

### 8.6 Parameter miner

Extracts query / body / JSON / cookie parameter names and samples.

- Filter box (cyber-themed)  
- **→ REP** opens sample request in Repeater  
- **→ WORDLIST** pushes names/samples into Intruder simple list  

### 8.7 Cookie jar

Load browser cookies for a URL (`chrome.cookies`).

- View name, domain, path, value  
- Copy listing  
- Use Repeater **COOKIES** tab to edit and send overrides  

### 8.8 Issue board

Persistent list of passive findings from history.

- **SCAN HISTORY** — HSTS, CORS, 401/403, 5xx, sensitive paths  
- Click row → open request  
- **CLEAR** empties the board (storage)  

### 8.9 WebSocket client

- Connect to `ws://` or `wss://` (SSRF-blocked private hosts)  
- Send/receive log  
- Fill URL from history handshakes  

### 8.10 JWT editor

- Load JWT → edit header/payload JSON  
- Rebuild unsigned (`alg:none`) or **HS256** re-sign with secret  
- Copy output  

### 8.11 Passive checks

One-shot heuristics (same family as Issue board). Local only — not an active scanner.

### 8.12 Project save / load

JSON export/import of:

- History (up to 500 entries, sanitized)  
- Scope  
- Notes  
- Bookmarks  
- Match/replace rules  

Size-capped (~15MB). Stays on disk you choose — nothing is uploaded.

---

## 9. Decoder

**Tab:** DECODER  

Transforms:

- Base64 / URL / HTML / Hex encode & decode  
- JSON format  
- JWT decode (+ warnings for weak algs)  
- SHA-256 (Web Crypto)  

**⇄ TO OUTPUT→INPUT** chains steps.

---

## 10. Keyboard shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `Ctrl+Enter` | Repeater fields | Send |
| `Ctrl+Enter` | Intercept fields | Forward |
| `F` / `D` | Intercept (not typing) | Forward / Drop |
| `Ctrl+L` | Global | Clear history |
| `Ctrl+F` | Global | Focus History filter |

---

## 11. Security notes

- Outbound Repeater/Intruder/WS targets: **no private/metadata hosts** (SSRF guard).  
- Header/body sanitization strips CR/LF injection characters.  
- Regex inputs are length-capped and reject nested quantifiers (ReDoS).  
- UI rendering uses text nodes / safe DOM — not raw `innerHTML` for untrusted data.  
- Intercept and wordlists never leave the browser.  
- Debugger mode shows a browser warning by design.  

---

## 12. Limitations

- History does **not** store full response bodies passively (`webRequest` platform limit); use Repeater, RES PRETTY, or Intercept.  
- Page-hook intercept covers **fetch/XHR**, not every navigation/subresource (use debugger mode for broader coverage).  
- Only one debugger per tab — DevTools and debugger-intercept cannot both attach.  
- HTTP/2 vs HTTP/1.1 is not always visible on passive history rows.  
- Not a system-wide MITM proxy and does not install CA certificates.  

---

## Quick workflows

### Bug bounty API test

1. Scope → add `target.com` → SCOPE ON.  
2. Browse app with History open.  
3. Interesting request → **SEND TO REPEATER** → tweak → SEND.  
4. **⚡ FUZZ** → mark param with `§…§` → wordlist → attack.  

### Live tamper

1. Standalone → Target Tab → Intercept ON.  
2. Trigger action in the page.  
3. Edit POST body in queue → Forward.  

### Diff two responses

1. Repeater SEND → **CMP A**.  
2. Change payload → SEND → **CMP B**.  
3. Tools → Compare → COMPARE.  

---

*PhantomProxy v2.3.0 — first stable public feature set for this line of work.*
