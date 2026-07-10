// PhantomProxy v2.2.0 — Features Module
// Scope Control | Auto-highlight | HAR Export/Import | cURL Import
// Designed as a self-contained module that hooks into panel.js state
"use strict";

// ═══════════════════════════════════════════════════════
// HIGHLIGHT ENGINE
// Declarative rule table — each rule defines what to look
// for and what badge/color to show. Easy to extend.
// ═══════════════════════════════════════════════════════

var HIGHLIGHT_RULES = [
  // Auth & tokens
  {
    id: "jwt",
    label: "JWT",
    color: "#b44fff",
    priority: 10,
    test: function(req) {
      // Only flag actual JWT-shaped tokens — not every Authorization header
      var all = JSON.stringify(req.requestHeaders || {});
      return /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/.test(all);
    }
  },
  {
    id: "apikey",
    label: "API KEY",
    color: "#ff9f43",
    priority: 9,
    test: function(req) {
      var hdrs = JSON.stringify(req.requestHeaders || {}).toLowerCase();
      var url  = (req.url || "").toLowerCase();
      return hdrs.indexOf("x-api-key") >= 0 || hdrs.indexOf("api-key") >= 0 ||
             url.indexOf("api_key=") >= 0   || url.indexOf("apikey=") >= 0;
    }
  },
  {
    id: "auth",
    label: "AUTH",
    color: "#00e5ff",
    priority: 8,
    test: function(req) {
      var h = JSON.stringify(req.requestHeaders || {}).toLowerCase();
      return h.indexOf("bearer ") >= 0 || h.indexOf("basic ") >= 0 ||
             h.indexOf("x-auth") >= 0  || h.indexOf("x-token") >= 0;
    }
  },
  // Sensitive endpoints
  {
    id: "admin",
    label: "ADMIN",
    color: "#ff3860",
    priority: 10,
    test: function(req) {
      var u = req.url.toLowerCase();
      return u.indexOf("/admin") >= 0 || u.indexOf("/dashboard") >= 0 ||
             u.indexOf("/manage") >= 0 || u.indexOf("/console") >= 0 ||
             u.indexOf("/superuser") >= 0;
    }
  },
  {
    id: "sensitive",
    label: "SENSITIVE",
    color: "#ff3860",
    priority: 9,
    test: function(req) {
      var u = req.url.toLowerCase();
      return u.indexOf("/password") >= 0 || u.indexOf("/reset") >= 0 ||
             u.indexOf("/token") >= 0    || u.indexOf("/secret") >= 0 ||
             u.indexOf("/private") >= 0  || u.indexOf("/internal") >= 0 ||
             u.indexOf("/.env") >= 0     || u.indexOf("/config") >= 0;
    }
  },
  {
    id: "upload",
    label: "UPLOAD",
    color: "#ffb700",
    priority: 7,
    test: function(req) {
      var u = req.url.toLowerCase();
      var h = JSON.stringify(req.requestHeaders || {}).toLowerCase();
      return u.indexOf("/upload") >= 0 || u.indexOf("/file") >= 0 ||
             h.indexOf("multipart/form-data") >= 0;
    }
  },
  // Status-based
  {
    id: "forbidden",
    label: "403",
    color: "#ffb700",
    priority: 8,
    test: function(req) { return req.statusCode === 403; }
  },
  {
    id: "server-error",
    label: "5xx",
    color: "#ff3860",
    priority: 9,
    test: function(req) { return req.statusCode >= 500 && req.statusCode < 600; }
  },
  {
    id: "redirect",
    label: "REDIRECT",
    color: "#4d9fff",
    priority: 5,
    test: function(req) { return req.statusCode >= 300 && req.statusCode < 400; }
  },
  // Data patterns in body
  {
    id: "sqli-hint",
    label: "SQL?",
    color: "#ff3860",
    priority: 10,
    test: function(req) {
      var b = (req.requestBody || "").toLowerCase();
      return b.indexOf("select ") >= 0 || b.indexOf("union ") >= 0 ||
             b.indexOf("' or ") >= 0   || b.indexOf("--") >= 0 ||
             b.indexOf("1=1") >= 0;
    }
  },
  {
    id: "graphql",
    label: "GraphQL",
    color: "#e10098",
    priority: 6,
    test: function(req) {
      var u = req.url.toLowerCase();
      var b = (req.requestBody || "").toLowerCase();
      return u.indexOf("/graphql") >= 0 || b.indexOf("query {") >= 0 ||
             b.indexOf("mutation {") >= 0;
    }
  },
  {
    id: "websocket",
    label: "WS",
    color: "#00ff9d",
    priority: 6,
    test: function(req) { return req.type === "websocket"; }
  }
];

// Evaluate all rules against a request — returns array of matching rules sorted by priority
function getHighlights(req) {
  return HIGHLIGHT_RULES
    .filter(function(rule) { return rule.test(req); })
    .sort(function(a, b) { return b.priority - a.priority });
}

// Build highlight badge DOM element
function makeHighlightBadge(rule) {
  var badge = document.createElement("span");
  badge.className = "highlight-badge";
  badge.textContent = rule.label;
  badge.style.cssText = "background:" + rule.color + "22;color:" + rule.color +
    ";border:1px solid " + rule.color + "55;border-radius:2px;" +
    "font-family:var(--font-ui);font-size:9px;font-weight:700;" +
    "letter-spacing:1px;padding:1px 5px;white-space:nowrap;";
  badge.title = "Auto-detected: " + rule.label;
  return badge;
}

// ═══════════════════════════════════════════════════════
// SCOPE ENGINE
// Domains can be IN scope (captured+shown) or OUT of scope
// (captured but dimmed/hidden based on mode)
//
// Pattern syntax (per entry):
//   example.com          → host + all subdomains
//   *.example.com        → wildcards (* = any chars in host)
//   api-*.cdn.com        → mid-string wildcards
//   example.com/api/*    → host + path wildcard (matched on URL)
//   /regex/i             → full JS regex against host or full URL
// ═══════════════════════════════════════════════════════

var scopeState = {
  enabled:  false,
  mode:     "dim",     // "dim" = show but grey out | "hide" = remove from list
  domains:  [],        // array of strings — hostname / path / regex patterns
  _cache:   {}
};

function scopeInit() {
  // Load from storage
  chrome.storage.local.get("phantomScope", function(data) {
    if (data.phantomScope) {
      Object.assign(scopeState, data.phantomScope);
      scopeState._cache = {};
      // Guard against corrupted storage shapes
      if (!Array.isArray(scopeState.domains)) scopeState.domains = [];
      if (scopeState.mode !== "hide") scopeState.mode = "dim";
      renderScopeList();
      updateScopeUI();
    }
  });
}

function scopeSave() {
  scopeState._cache = {};
  chrome.storage.local.set({ phantomScope: {
    enabled: scopeState.enabled,
    mode:    scopeState.mode,
    domains: scopeState.domains
  }});
}

/**
 * Escape a string for use inside a RegExp, then turn * into .*
 */
function wildcardToRegexSource(pattern) {
  return pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
}

/**
 * Test a single scope pattern against a URL.
 * Returns true on match. Never throws.
 */
function matchScopePattern(rawPattern, host, fullUrl) {
  if (!rawPattern || typeof rawPattern !== "string") return false;
  var pattern = rawPattern.trim();
  if (!pattern) return false;
  // ReDoS / abuse caps
  if (pattern.length > 200) return false;

  // ── Explicit regex: /pattern/flags ──
  if (pattern.charAt(0) === "/") {
    var lastSlash = pattern.lastIndexOf("/");
    if (lastSlash > 0) {
      var body  = pattern.slice(1, lastSlash);
      var flags = pattern.slice(lastSlash + 1) || "i";
      // Prefer shared safeRegExp when available
      if (window.PhantomSecurity) {
        var sr = PhantomSecurity.safeRegExp(body, flags);
        if (!sr.ok) return false;
        try {
          return sr.re.test(host) || sr.re.test(fullUrl);
        } catch (e) {
          return false;
        }
      }
      if (!/^[gimsuy]{0,6}$/.test(flags)) flags = "i";
      if (/\([^)]*[+*{][^)]*\)[+*{]/.test(body)) return false;
      try {
        var re = new RegExp(body, flags);
        return re.test(host) || re.test(fullUrl);
      } catch (e) {
        return false; // invalid regex → no match (don't crash UI)
      }
    }
  }

  var lower = pattern.toLowerCase();
  var hasPath = lower.indexOf("/") >= 0;
  var hasWild = lower.indexOf("*") >= 0;

  // ── Path / URL patterns (contain /) ──
  if (hasPath) {
    var target = fullUrl.replace(/^https?:\/\//i, "").toLowerCase();
    var pat    = lower.replace(/^https?:\/\//i, "");
    if (hasWild) {
      try {
        return new RegExp("^" + wildcardToRegexSource(pat) + "$", "i").test(target) ||
               new RegExp(wildcardToRegexSource(pat), "i").test(fullUrl);
      } catch (e) {
        return false;
      }
    }
    return target.indexOf(pat) >= 0 || fullUrl.toLowerCase().indexOf(pat) >= 0;
  }

  // ── Hostname wildcards ──
  if (hasWild) {
    try {
      if (new RegExp("^" + wildcardToRegexSource(lower) + "$", "i").test(host)) {
        return true;
      }
      // README / Burp-style convenience: *.example.com also matches the apex
      if (lower.indexOf("*.") === 0) {
        var apex = lower.slice(2);
        if (apex && host === apex) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // ── Exact host or any subdomain ──
  // "example.com" matches example.com and foo.example.com
  // but not notexample.com (requires leading dot for subdomain)
  return host === lower || host.endsWith("." + lower);
}

/**
 * Match URL against configured domain patterns (ignores enabled flag).
 * Used by the History "IN SCOPE ONLY" chip so it works even when
 * the global SCOPE toggle is OFF — as documented.
 */
function scopeMatchDomain(url) {
  if (!scopeState.domains.length) return true;
  if (scopeState._cache[url] !== undefined) return scopeState._cache[url];

  var host, fullUrl;
  try {
    var u = new URL(url);
    host    = u.hostname.toLowerCase();
    fullUrl = url;
  } catch (e) {
    scopeState._cache[url] = true;
    return true;
  }

  var match = scopeState.domains.some(function(pattern) {
    return matchScopePattern(pattern, host, fullUrl);
  });
  scopeState._cache[url] = match;
  return match;
}

/**
 * Global scope filter used for DIM/HIDE mode.
 * When scope is disabled (or empty), everything is considered in-scope.
 */
function scopeMatch(url) {
  if (!scopeState.enabled || !scopeState.domains.length) return true;
  return scopeMatchDomain(url);
}

/**
 * Normalize user input before adding to the scope list.
 * Preserves wildcards, path patterns, and /regex/ forms.
 * Only extracts hostname from plain full URLs.
 */
function normalizeScopeInput(val) {
  val = (val || "").trim();
  if (!val) return "";

  // Keep explicit regex as-is (case-sensitive body is intentional)
  if (val.charAt(0) === "/" && val.lastIndexOf("/") > 0) return val;

  // Keep pure wildcards / mid-wildcards (hostname only)
  if (val.indexOf("*") >= 0 && val.indexOf("://") < 0) {
    return val.toLowerCase();
  }

  // Path pattern without scheme: example.com/api/*
  if (val.indexOf("/") >= 0 && val.indexOf("://") < 0) {
    return val.toLowerCase();
  }

  // Full URL (with or without scheme) → extract hostname (+ path if meaningful)
  try {
    var candidate = val.indexOf("://") < 0 ? "https://" + val : val;
    var parsed = new URL(candidate);
    var host = parsed.hostname.toLowerCase();
    if (!host) return val.toLowerCase();
    // Preserve path when user pasted more than just origin
    if (parsed.pathname && parsed.pathname !== "/") {
      return host + parsed.pathname + (parsed.search || "");
    }
    return host;
  } catch (e) {
    return val.toLowerCase();
  }
}

function scopeAddDomain(domain) {
  domain = normalizeScopeInput(domain);
  if (!domain) return;
  // Case-sensitive compare for /regex/, lowercased for the rest
  var exists = scopeState.domains.some(function(d) {
    return d === domain || d.toLowerCase() === domain.toLowerCase();
  });
  if (exists) return;
  scopeState.domains.push(domain);
  scopeSave();
  renderScopeList();
}

function scopeRemoveDomain(domain) {
  scopeState.domains = scopeState.domains.filter(function(d) { return d !== domain; });
  scopeSave();
  renderScopeList();
}

function renderScopeList() {
  var list = document.getElementById("scope-domain-list");
  if (!list) return;
  list.innerHTML = "";
  if (!scopeState.domains.length) {
    var empty = document.createElement("div");
    empty.className = "scope-empty";
    empty.textContent = "No domains in scope — all traffic shown";
    list.appendChild(empty);
    return;
  }
  scopeState.domains.forEach(function(domain) {
    var row  = document.createElement("div");
    row.className = "scope-row";
    var icon = document.createElement("span");
    icon.className = "scope-dot";
    // Visual hint for pattern type
    if (domain.charAt(0) === "/") icon.title = "Regex pattern";
    else if (domain.indexOf("*") >= 0) icon.title = "Wildcard pattern";
    else if (domain.indexOf("/") >= 0) icon.title = "Path pattern";
    else icon.title = "Domain (includes subdomains)";
    var lbl  = document.createElement("span");
    lbl.className   = "scope-domain-label";
    lbl.textContent = domain;
    var del  = document.createElement("button");
    del.className   = "scope-del-btn";
    del.textContent = "✕";
    del.addEventListener("click", function() { scopeRemoveDomain(domain); });
    row.append(icon, lbl, del);
    list.appendChild(row);
  });
}

function updateScopeUI() {
  var toggle = document.getElementById("scope-toggle");
  var badge  = document.getElementById("scope-badge");
  var modeBtn = document.getElementById("scope-mode-toggle");
  if (toggle) {
    toggle.classList.toggle("active", scopeState.enabled);
    toggle.textContent = scopeState.enabled ? "SCOPE ON" : "SCOPE OFF";
  }
  if (modeBtn) {
    modeBtn.textContent = scopeState.mode === "dim" ? "MODE: DIM" : "MODE: HIDE";
  }
  if (badge) {
    badge.textContent = scopeState.enabled
      ? "SCOPE: " + scopeState.domains.length + " domain" + (scopeState.domains.length !== 1 ? "s" : "")
      : "SCOPE: OFF";
    badge.classList.toggle("scope-active", scopeState.enabled);
  }
}

// ═══════════════════════════════════════════════════════
// HAR EXPORT
// Exports captured requests as HAR 1.2 format
// Compatible with Burp, Chrome DevTools, Postman
// ═══════════════════════════════════════════════════════

function exportHAR(requests) {
  var entries = requests.map(function(req) {
    var started = new Date(req.timestamp || Date.now()).toISOString();
    var reqHdrs = Object.keys(req.requestHeaders || {}).map(function(k) {
      return { name: k, value: req.requestHeaders[k] };
    });
    var resHdrs = Object.keys(req.responseHeaders || {}).map(function(k) {
      return { name: k, value: req.responseHeaders[k] };
    });
    var postData = null;
    if (req.requestBody) {
      var ct = (req.requestHeaders || {})["Content-Type"] ||
               (req.requestHeaders || {})["content-type"] || "";
      postData = { mimeType: ct, text: req.requestBody };
    }
    return {
      startedDateTime: started,
      time: req.duration || 0,
      request: {
        method: req.method,
        url: req.url,
        httpVersion: "HTTP/1.1",
        headers: reqHdrs,
        queryString: parseQS(req.url),
        cookies: [],
        headersSize: -1,
        bodySize: req.requestBody ? req.requestBody.length : 0,
        postData: postData
      },
      response: {
        status: req.statusCode || 0,
        statusText: "",
        httpVersion: "HTTP/1.1",
        headers: resHdrs,
        cookies: [],
        content: { size: -1, mimeType: "", text: "" },
        redirectURL: "",
        headersSize: -1,
        bodySize: -1
      },
      cache: {},
      timings: { send: 0, wait: req.duration || 0, receive: 0 }
    };
  });

  var har = {
    log: {
      version: "1.2",
      creator: { name: "PhantomProxy", version: "2.2.0" },
      entries: entries
    }
  };

  var blob = new Blob([JSON.stringify(har, null, 2)], { type: "application/json" });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement("a");
  a.href     = url;
  a.download = "phantomproxy-" + Date.now() + ".har";
  a.click();
  URL.revokeObjectURL(url);
}

function parseQS(url) {
  try {
    return Array.from(new URL(url).searchParams.entries()).map(function(p) {
      return { name: p[0], value: p[1] };
    });
  } catch(e) { return []; }
}

// ═══════════════════════════════════════════════════════
// HAR IMPORT
// Reads a HAR file and converts entries to PhantomProxy
// request format, pushing into allRequests
// ═══════════════════════════════════════════════════════

function importHAR(file, onDone) {
  if (!file) { onDone("No file", null); return; }
  var maxBytes = 15 * 1024 * 1024;
  if (file.size > maxBytes) {
    onDone("HAR too large (max 15MB)", null);
    return;
  }
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var text = String(e.target.result || "");
      if (text.length > maxBytes) {
        onDone("HAR too large (max 15MB)", null);
        return;
      }
      var har     = JSON.parse(text);
      var entries = ((har.log && har.log.entries) || []).slice(0, 500);
      var imported = [];
      var allowed = ["GET","POST","PUT","PATCH","DELETE","OPTIONS","HEAD"];
      entries.forEach(function(entry, i) {
        var r    = entry.request  || {};
        var res  = entry.response || {};
        var reqH = Object.create(null);
        (r.headers || []).forEach(function(h) {
          if (!h || typeof h.name !== "string") return;
          var n = h.name.replace(/[\r\n\0]/g, "").slice(0, 256);
          if (!n || n === "__proto__" || n === "constructor") return;
          reqH[n] = String(h.value == null ? "" : h.value).replace(/[\r\n\0]/g, " ").slice(0, 64 * 1024);
        });
        var resH = Object.create(null);
        (res.headers || []).forEach(function(h) {
          if (!h || typeof h.name !== "string") return;
          var n = h.name.replace(/[\r\n\0]/g, "").slice(0, 256);
          if (!n || n === "__proto__" || n === "constructor") return;
          resH[n] = String(h.value == null ? "" : h.value).replace(/[\r\n\0]/g, " ").slice(0, 64 * 1024);
        });
        var method = String(r.method || "GET").toUpperCase();
        if (allowed.indexOf(method) < 0) method = "GET";
        imported.push({
          id:              "har_" + Date.now() + "_" + i,
          requestId:       "har_" + i,
          url:             String(r.url || "").slice(0, 8192),
          method:          method,
          timestamp:       new Date(entry.startedDateTime || Date.now()).getTime(),
          tabId:           -1,
          type:            "xmlhttprequest",
          status:          "complete",
          requestBody:     (r.postData && typeof r.postData.text === "string")
                             ? r.postData.text.slice(0, 64 * 1024) : null,
          requestHeaders:  reqH,
          responseHeaders: resH,
          statusCode:      typeof res.status === "number" ? res.status : 0,
          duration:        typeof entry.time === "number" ? entry.time : 0,
          _imported:       true
        });
      });
      onDone(null, imported);
    } catch(err) {
      onDone("Invalid HAR file: " + err.message, null);
    }
  };
  reader.onerror = function() { onDone("Failed to read file", null); };
  reader.readAsText(file);
}

// ═══════════════════════════════════════════════════════
// CURL IMPORT
// Parses a cURL command into repeater-ready request object
// Handles: -X method, -H headers, -d body, --data-raw,
//          --data-urlencode, -u user:pass, -b cookies,
//          --compressed, -L follow-redirects (noted only)
// ═══════════════════════════════════════════════════════

function parseCurl(cmd) {
  // Normalise line continuations and collapse whitespace
  var raw = cmd.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();

  var result = { method: "GET", url: "", headers: {}, body: null, errors: [] };

  // Extract URL — first bare arg that starts with http
  var urlMatch = raw.match(/curl\s+(?:[^'"]\S*\s+)*['"]?(https?:\/\/[^\s'"]+)['"]?/);
  if (!urlMatch) {
    // Try URL anywhere
    urlMatch = raw.match(/['"]?(https?:\/\/[^'">\s]+)['"]?/);
  }
  if (urlMatch) result.url = urlMatch[1].replace(/['"]/g, "");

  // Method
  var mMatch = raw.match(/-X\s+['"]?(\w+)['"]?/);
  if (mMatch) result.method = mMatch[1].toUpperCase();

  // Headers — handle multiple -H flags
  var hRe = /-H\s+['"]([^'"]+)['"]/g;
  var hm;
  while ((hm = hRe.exec(raw)) !== null) {
    var colonIdx = hm[1].indexOf(":");
    if (colonIdx > 0) {
      var k = hm[1].slice(0, colonIdx).trim();
      var v = hm[1].slice(colonIdx + 1).trim();
      result.headers[k] = v;
    }
  }

  // Body — -d, --data, --data-raw
  var bodyMatch = raw.match(/(?:--data-raw|--data|-d)\s+['"]([\s\S]*?)['"]\s*(?:-|$)/);
  if (!bodyMatch) bodyMatch = raw.match(/(?:--data-raw|--data|-d)\s+['"]?([\s\S]*?)['"]?\s*(?=$|-[A-Z]|--)/);
  if (bodyMatch) {
    result.body = bodyMatch[1];
    if (result.method === "GET") result.method = "POST";
  }

  // Basic auth -u user:pass -> Authorization header
  var authMatch = raw.match(/-u\s+['"]?([^'":\s]+):([^'"\s]+)['"]?/);
  if (authMatch) {
    result.headers["Authorization"] = "Basic " + btoa(authMatch[1] + ":" + authMatch[2]);
  }

  // Cookie -b
  var cookieMatch = raw.match(/-b\s+['"]([^'"]+)['"]/);
  if (cookieMatch) result.headers["Cookie"] = cookieMatch[1];

  if (!result.url) result.errors.push("Could not parse URL");

  return result;
}

// ═══════════════════════════════════════════════════════
// FEATURE UI WIRING
// Called once after panel DOM is ready
// ═══════════════════════════════════════════════════════

function featuresInit(getRequests, addRequests, renderList, setStatus) {

  // ── Scope toggle ──
  var scopeToggle = document.getElementById("scope-toggle");
  if (scopeToggle) {
    scopeToggle.addEventListener("click", function() {
      scopeState.enabled = !scopeState.enabled;
      scopeSave();
      updateScopeUI();
      renderList();
      setStatus(scopeState.enabled ? "Scope filter ON" : "Scope filter OFF");
    });
  }

  var scopeModeToggle = document.getElementById("scope-mode-toggle");
  if (scopeModeToggle) {
    scopeModeToggle.addEventListener("click", function() {
      scopeState.mode = scopeState.mode === "dim" ? "hide" : "dim";
      scopeSave();
      scopeModeToggle.textContent = scopeState.mode === "dim" ? "MODE: DIM" : "MODE: HIDE";
      renderList();
    });
  }

  var scopeInput = document.getElementById("scope-input");
  var scopeAdd   = document.getElementById("btn-scope-add");
  if (scopeAdd && scopeInput) {
    function addFromInput() {
      var raw = scopeInput.value.trim();
      if (!raw) return;
      // Validate explicit regex before adding so user gets feedback
      if (raw.charAt(0) === "/") {
        var ls = raw.lastIndexOf("/");
        if (ls > 0) {
          try {
            new RegExp(raw.slice(1, ls), raw.slice(ls + 1) || "i");
          } catch (err) {
            setStatus("Invalid regex: " + err.message);
            return;
          }
        }
      }
      var val = normalizeScopeInput(raw);
      if (!val) return;
      scopeAddDomain(val);
      scopeInput.value = "";
      updateScopeUI();
      renderList();
      setStatus("Added to scope: " + val);
    }
    scopeAdd.addEventListener("click", addFromInput);
    scopeInput.addEventListener("keydown", function(e) { if (e.key === "Enter") addFromInput(); });
  }

  // Add from selected request button
  var scopeAddCurrent = document.getElementById("btn-scope-add-current");
  if (scopeAddCurrent) {
    scopeAddCurrent.addEventListener("click", function() {
      var reqs = getRequests();
      // Add all unique domains from current history
      var added = 0;
      reqs.forEach(function(req) {
        try {
          var host = new URL(req.url).hostname.toLowerCase();
          if (scopeState.domains.indexOf(host) < 0) {
            scopeState.domains.push(host);
            added++;
          }
        } catch(e) {}
      });
      if (added) {
        scopeSave();
        renderScopeList();
        updateScopeUI();
        renderList();
        setStatus("Added " + added + " domain" + (added !== 1 ? "s" : "") + " from history");
      } else {
        setStatus("All current domains already in scope");
      }
    });
  }

  // ── Export / Import ──
  var exportBtn = document.getElementById("btn-export-har");
  if (exportBtn) {
    exportBtn.addEventListener("click", function() {
      var reqs = getRequests();
      if (!reqs.length) { setStatus("No requests to export"); return; }
      exportHAR(reqs);
      setStatus("Exported " + reqs.length + " requests as HAR ✓");
    });
  }

  var importInput = document.getElementById("import-har-input");
  var importBtn   = document.getElementById("btn-import-har");
  if (importBtn && importInput) {
    importBtn.addEventListener("click", function() { importInput.click(); });
    importInput.addEventListener("change", function(e) {
      var file = e.target.files[0];
      if (!file) return;
      setStatus("Importing " + file.name + "…");
      importHAR(file, function(err, imported) {
        if (err) { setStatus("Import failed: " + err); return; }
        addRequests(imported);
        renderList();
        setStatus("Imported " + imported.length + " requests from HAR ✓");
        importInput.value = "";
      });
    });
  }

  // ── cURL Import into Repeater ──
  var curlImportBtn   = document.getElementById("btn-import-curl");
  var curlImportInput = document.getElementById("curl-import-textarea");
  var curlImportPanel = document.getElementById("curl-import-panel");

  if (curlImportBtn) {
    curlImportBtn.addEventListener("click", function() {
      if (curlImportPanel) {
        curlImportPanel.classList.toggle("hidden");
        if (!curlImportPanel.classList.contains("hidden") && curlImportInput) {
          curlImportInput.focus();
        }
      }
    });
  }

  var curlImportDo = document.getElementById("btn-curl-import-do");
  if (curlImportDo && curlImportInput) {
    curlImportDo.addEventListener("click", function() {
      var cmd = curlImportInput.value.trim();
      if (!cmd) return;
      var parsed = parseCurl(cmd);
      if (parsed.errors.length) {
        setStatus("cURL parse warning: " + parsed.errors.join(", "));
      }
      // Fire custom event — panel.js listens and creates a repeater session
      document.dispatchEvent(new CustomEvent("phantom:curl-import", { detail: parsed }));
      curlImportInput.value = "";
      if (curlImportPanel) curlImportPanel.classList.add("hidden");
      setStatus("cURL imported into Repeater ✓");
    });

    // Ctrl+Enter to import
    curlImportInput.addEventListener("keydown", function(e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) curlImportDo.click();
    });
  }

  // Init scope from storage
  scopeInit();
}

// ═══════════════════════════════════════════════════════
// PUBLIC API — exposed on window.PhantomFeatures
// ═══════════════════════════════════════════════════════
window.PhantomFeatures = {
  init:               featuresInit,
  getHighlights:      getHighlights,
  makeHighlightBadge: makeHighlightBadge,
  scopeMatch:         scopeMatch,
  scopeMatchDomain:   scopeMatchDomain,
  scopeState:         scopeState,
  exportHAR:          exportHAR,
  parseCurl:          parseCurl
};
