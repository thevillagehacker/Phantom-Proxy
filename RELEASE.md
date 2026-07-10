# Release Notes — PhantomProxy v2.3.0

**Tag:** `v2.3.0`  
**Codename:** First complete toolkit release  
**Date:** 2026-07-10  

This is the **first polished public release** of the PhantomProxy line that packages proxy-style history, repeater, scope, intercept, and Burp-inspired tooling into a Manifest V3 browser extension.

Full usage documentation: **[USAGE.md](./USAGE.md)**

---

## Highlights

- **Proxy Intercept** with dual engines (debugger + page-hook) and correct **POST/PUT body forwarding**
- **Intruder** with sniper / pitchfork / cluster bomb, wordlists, number ranges, grep on results
- **Unified Compare** (History + Repeater)
- **Tools suite**: sitemap, search, match/replace, params, cookie jar, issues, WebSocket, JWT, project I/O
- **Security-first** SSRF blocks, regex caps, header sanitization

---

## What's new since early 2.x

### Intercept
- Hold live traffic, edit method/URL/headers/body, forward or drop
- **Debugger mode** — broad HTTP intercept (Standalone + target tab)
- **Page-hook mode** — fetch/XHR intercept that works with DevTools open
- **In-scope only**, optional **response stage**, prefer-page-hook toggle
- Keyboard **F** / **D**
- **POST fix:** pure Forward no longer strips or empties request bodies; edited bodies recalculate `Content-Length`; FormData/Blob preserved on pure page-hook forward

### Intruder
- Markers in URL, headers, and body
- Payload sets: simple, numbers, wordlist file, brute, null, dates, runtime file
- Attack modes: sniper, pitchfork, cluster bomb
- Processors: URL-encode, Base64, double URL, prefix/suffix
- Result inspector (request/response) + grep
- Entry points: History **FUZZ**, Repeater **FUZZ**, Sitemap right-click

### History & Repeater
- Cookie capture (`extraHeaders`) + Repeater COOKIES editor + browser jar load
- Notes/tags, bookmarks, HAR import/export, cURL import
- Compare A/B from History and Repeater

### Scope
- Wildcards, path patterns, `/regex/`, safe validation
- DIM / HIDE + History “in scope only”

### Tools
- Sitemap, global search, match/replace, param miner → wordlist
- Cookie jar, issue board, WebSocket client, JWT editor, passive scan, project save/load
- Single **Compare** pane (CLEAR + re-run)

### Security
- Expanded private/metadata host blocks (incl. decimal IPs)
- Outbound queue limits for fuzzer/repeater
- Safe regex compile, import size caps, prototype-pollution guards

---

## Upgrade notes

1. Reload the extension after install (`chrome://extensions` → Reload).  
2. Accept the **debugger** permission if prompted (optional but needed for full intercept).  
3. For intercept in DevTools: enable Intercept → **reload the target page**.  
4. For intercept in Standalone: select a **specific Target Tab**, not “All Tabs”.

---

## Breaking / behavior changes

- Comparer is **unified** (old separate Diff + Compare UIs merged). Use **CLEAR** between comparisons.
- Intercept defaults to **page-hook** inside the DevTools panel so it actually starts when the debugger is already taken.
- Payload cap raised to **500** with hard safety limits on brute/cluster products.

---

## Known limitations

- Passive history does not store full response bodies (browser API limit).  
- Page-hook intercept does not see every subresource (use debugger mode).  
- Cannot attach debugger intercept while DevTools is debugging the same tab.  
- Not a system MITM proxy; no custom CA.

---

## Files of interest

```
manifest.json          # v2.3.0
panel/                 # UI
background/worker.js   # Capture, repeater, intercept
content/               # Page-hook intercept scripts
USAGE.md               # Full usage guide
RELEASE.md             # This file
```

---

## Credits

Built for security researchers and bug bounty hunters who want Burp-like workflows without leaving the browser.

---

## GitHub release checklist

When publishing on GitHub:

1. Tag: `git tag -a v2.3.0 -m "PhantomProxy v2.3.0"`  
2. Push tag and create a Release with the body of this file.  
3. Attach a zip of the extension folder if distributing binaries.  
4. Link **USAGE.md** in the release description.  

---

**PhantomProxy v2.3.0** — ready for first public showcase.
