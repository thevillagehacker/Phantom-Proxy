# PhantomProxy v2.3.0

**Released:** 11 July 2026  
**Tag:** [`v2.3.0`](https://github.com/thevillagehacker/Phantom-Proxy/releases/tag/v2.3.0)

First complete public toolkit release: scope, intercept, history, repeater, intruder, and tools suite in a Manifest V3 extension for Edge and Chrome.

**Docs:** [USAGE.md](./USAGE.md) · [README.md](./README.md)

---

## Highlights

1. **Proxy Intercept** — hold, edit, forward, or drop live requests (debugger + page-hook)
2. **Intruder** — § markers, sniper / pitchfork / cluster bomb, wordlists, result grep
3. **Unified Compare** — one comparer for History and Repeater
4. **Full Tools suite** — sitemap, search, match/replace, params, cookies, issues, WebSocket, JWT, projects
5. **Security hardening** — SSRF guards, safe regex, header sanitization, import caps

---

## New features (by UI order)

### 1. Scope
- Domain list with wildcards (`*.example.com`), path patterns, and `/regex/i`
- **DIM** / **HIDE** modes for out-of-scope traffic
- Persist across sessions; **ADD ALL FROM HISTORY**
- History **IN SCOPE ONLY** chip (independent of global toggle)

### 2. Intercept
- Live request hold → edit method / URL / headers / body → **Forward** or **Drop**
- **Debugger mode** — broad HTTP coverage (Standalone + specific Target Tab)
- **Page-hook mode** — `fetch` / XHR (works with DevTools open)
- Options: in-scope only, + response stage, prefer page hook
- Keyboard: **F** forward · **D** drop
- **POST/PUT safe forward** — pure Forward keeps original body (including FormData); edited bodies update `Content-Length`

### 3. History
- Passive capture (method, URL, headers, body when available, status, type, timing)
- Filters: text, method, status, multi-select type, scope, bookmarks
- Detail: headers/body, RES PRETTY re-fetch, raw, cURL copy
- Bookmarks (right-click colors + notes), auto FLAGS, request notes/tags
- Actions: Send to Repeater, **FUZZ**, **CMP A / CMP B**, HAR export/import

### 4. Repeater
- Multi-session tabs; headers, **COOKIES**, body, raw HTTP
- Load browser cookies; cURL import
- Response raw/pretty, copy, wrap
- **⚡ FUZZ** sends current request to Intruder
- Match & replace rules applied on send
- Response bar **CMP A / CMP B** for Compare

### 5. Tools

| Tool | Description |
|------|-------------|
| **Sitemap** | Host → path tree; click → History; right-click → Intruder |
| **Search** | Global search (URL / headers / body); literal or safe regex |
| **Compare** | Single comparer — set A/B from History or Repeater; CLEAR and re-run |
| **Match / Replace** | Rewrite URL, headers, body, or cookies on send |
| **Intruder** | Positions in URL/headers/body; payload types; attack modes; grep results |
| **Params** | Extract query/body/JSON/cookie params; → wordlist / Repeater |
| **Cookie jar** | View cookies for a URL |
| **Issues** | Persistent passive findings board from history |
| **WebSocket** | Client for `ws://` / `wss://` with history handshakes |
| **JWT editor** | Edit claims; `alg:none` / HS256 re-sign |
| **Passive** | One-shot security header / CORS heuristics |
| **Project** | Export/import history + scope + notes + rules |

### 6. Decoder
- Base64, URL, HTML, Hex, JSON format, JWT decode, SHA-256
- Chain mode (output → input)

---

## Improvements & fixes

- Cookie header capture via `extraHeaders`; Set-Cookie multi-value handling
- Intercept pure Forward no longer empties POST bodies
- Unified Compare (removed separate Diff + Compare panes)
- Cyber-themed selects, checkboxes, params filter, method/delay controls
- Intruder payload cap **500** with safety limits on brute/cluster products
- Standalone **Target Tab** clarified (filters browser tab; Scope filters domains)

---

## Security

- SSRF blocks for private / link-local / metadata hosts (incl. decimal IP forms)
- Repeater/Intruder/WS outbound validation
- CRLF stripping on headers; ReDoS-resistant regex compile
- HAR/project import size and shape guards
- Prototype-pollution key rejection
- Outbound request queue concurrency limits

---

## Breaking / behavior changes

- **One Compare tool** — use CLEAR between comparisons
- DevTools panel intercept defaults to **page-hook** (debugger already held by DevTools)
- Intruder payload limit **500** (hard caps on combinatorial attacks)

---

## Upgrade notes

1. Reload the extension at `chrome://extensions` / `edge://extensions`
2. Accept **debugger** permission if you want full HTTP intercept
3. **DevTools intercept:** turn on Intercept → **reload the target page**
4. **Standalone intercept:** pick a **specific Target Tab** (not All Tabs)

---

## Known limitations

- Passive history does not store full response bodies (`webRequest` platform limit)
- Page-hook intercept covers fetch/XHR, not every subresource
- Debugger intercept cannot attach while DevTools is debugging the same tab
- Not a system MITM proxy; no custom CA install

---

## Version history (for reference)

| Version | Summary |
|---------|---------|
| **v2.3.0** | Intercept, Intruder, full Tools suite, unified Compare — this release |
| **v2.0.1** | Scope, flags, bookmarks, HAR, cURL import, standalone window, pretty responses |
| **v1.3.0** | Standalone/DevTools modes, response pretty, capture fixes |
| **v1.0.1** | Store listing / early public packaging |
| **v1.0.0** | Initial capture, History, Repeater, Decoder |

---

**PhantomProxy v2.3.0** — first complete public toolkit release.
