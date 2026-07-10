// PhantomProxy — Panel v2.3.0
// Scope · Intercept · History · Repeater · Tools · Decoder
"use strict";

// ─── Constants ────────────────────────────────────────
var ALLOWED_METHODS = ["GET","POST","PUT","PATCH","DELETE","OPTIONS","HEAD"];
var METHOD_CSS = {
  GET:"method-GET", POST:"method-POST", PUT:"method-PUT",
  DELETE:"method-DELETE", PATCH:"method-PATCH",
  OPTIONS:"method-OPTIONS", HEAD:"method-HEAD"
};

// ─── State ────────────────────────────────────────────
var allRequests       = [];
var selectedRequestId = null;
var captureActive     = true;
var methodFilter      = "ALL";
var statusFilter      = "ALL";
var urlFilter         = "";
var repeaterSessions  = [];
var activeSessionId   = null;
var sessionCounter    = 0;
var bgPort            = null;

// Bookmark filter toggle
var bookmarkFilterOn = false;
var typeFilters      = {};      // resource type multi-filter: { chipKey: true }
                               // empty = show ALL
var scopeFilterOn    = false;   // show in-scope only

// Bookmark state — persisted in chrome.storage.local
// { [requestId]: { color: "#hex", label: "string" } }
var bookmarkMap = {};

// Pretty print state
var lastRespBody      = "";
var lastRespType      = "";
var wrapOn            = true;

// Detect standalone mode from URL param
var IS_STANDALONE = (new URLSearchParams(window.location.search).get("mode") === "standalone");

// ─── Connection ───────────────────────────────────────
// MV3 service workers go idle. We wake the SW with a sendMessage
// BEFORE opening a port — this guarantees the SW is running
// when chrome.runtime.connect() is called, preventing
// "Receiving end does not exist" errors.

var _reconnectTimer = null;
var _connecting     = false;

function connectBackground() {
  if (_connecting) return;
  _connecting = true;

  // Step 1: Wake the service worker
  try {
    chrome.runtime.sendMessage({ type: "WAKE" }, function(response) {
      // Ignore errors here — SW may have been freshly started
      if (chrome.runtime.lastError) {
        // SW wasn't running — the sendMessage itself starts it.
        // Wait a tick for it to initialize then connect.
      }
      // Step 2: Now the SW is definitely awake — open the port
      _connecting = false;
      doConnect();
    });
  } catch(e) {
    // Extension context invalidated (e.g. extension was reloaded)
    // Stop trying — user needs to reopen DevTools
    _connecting = false;
    setStatus("Extension reloaded — please close and reopen DevTools");
    console.warn("PhantomProxy: extension context invalidated", e);
  }
}

function doConnect() {
  var portName;
  if (IS_STANDALONE) {
    portName = "phantom-standalone";
  } else {
    if (!chrome.devtools) {
      console.error("PhantomProxy: chrome.devtools not available");
      return;
    }
    portName = "phantom-devtools-" + chrome.devtools.inspectedWindow.tabId;
  }

  try {
    bgPort = chrome.runtime.connect({ name: portName });
  } catch(e) {
    console.error("PhantomProxy: connect failed:", e.message);
    scheduleReconnect();
    return;
  }

  bgPort.onMessage.addListener(onBgMessage);
  bgPort.onDisconnect.addListener(function() {
    bgPort = null;
    var err = chrome.runtime.lastError;
    if (err && err.message && err.message.indexOf("invalidated") >= 0) {
      // Extension was reloaded — stop reconnecting
      setStatus("Extension reloaded — please reopen DevTools");
      return;
    }
    setStatus("Reconnecting…");
    scheduleReconnect();
  });

  setStatus("PhantomProxy connected — capturing traffic");
}

function scheduleReconnect() {
  if (_reconnectTimer) clearTimeout(_reconnectTimer);
  _reconnectTimer = setTimeout(function() {
    _reconnectTimer = null;
    connectBackground();
  }, 1500);
}

function sendBg(msg) {
  if (bgPort) {
    try { bgPort.postMessage(msg); }
    catch(e) { console.error("sendBg failed:", e); }
  }
}

// ─── Message Handler (ONE definition only) ────────────
function onBgMessage(msg) {
  if (!msg || typeof msg.type !== "string") return;

  switch(msg.type) {
    case "INIT_REQUESTS":
      allRequests = Array.isArray(msg.requests) ? msg.requests : [];
      renderList();
      break;

    case "NEW_REQUEST":
      if (!captureActive || !msg.request) break;
      var existing = -1;
      for (var i = 0; i < allRequests.length; i++) {
        if (allRequests[i].requestId === msg.request.requestId) { existing = i; break; }
      }
      if (existing >= 0) {
        allRequests[existing] = msg.request;
        updateRow(msg.request);
      } else {
        allRequests.push(msg.request);
        appendRow(msg.request);
      }
      updateCount();
      break;

    case "REQUESTS_CLEARED":
      allRequests = [];
      selectedRequestId = null;
      renderList();
      showDetailEmpty();
      break;

    case "REQUEST_DELETED":
      allRequests = allRequests.filter(function(r) { return r.id !== msg.id; });
      if (selectedRequestId === msg.id) { selectedRequestId = null; showDetailEmpty(); }
      renderList();
      break;

    case "REPEATER_RESPONSE":
      // Route to detail-pretty, fuzzer, or repeater depending on id prefix
      if (typeof msg.id === "string" && msg.id.indexOf("dp_") === 0) {
        showDetailPrettyResult(msg.result);
      } else if (typeof msg.id === "string" && msg.id.indexOf("fuzz_") === 0) {
        if (window.PhantomAdvanced && PhantomAdvanced.handleFuzzResponse) {
          PhantomAdvanced.handleFuzzResponse(msg.id, msg.result);
        }
      } else {
        onRepeaterResponse(msg.id, msg.result);
      }
      break;

    case "COOKIES_RESULT":
      onCookiesResult(msg);
      break;

    case "INTERCEPT_STATE":
      onInterceptState(msg);
      break;
    case "INTERCEPT_PAUSED":
      onInterceptPaused(msg);
      break;
    case "INTERCEPT_RELEASED":
      onInterceptReleased(msg);
      break;
    case "INTERCEPT_ERROR":
      if (msg.error) setStatus("Intercept: " + msg.error);
      if (typeof msg.queueSize === "number") updateInterceptQueueCount(msg.queueSize);
      break;
    case "INTERCEPT_OVERFLOW":
      if (msg.message) setStatus("⚠ " + msg.message);
      break;
  }
}

// ─── Tab Navigation ───────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(function(btn) {
  btn.addEventListener("click", function() {
    switchTab(btn.dataset.tab);
  });
});

// ─── Filters ──────────────────────────────────────────
document.getElementById("filter-url").addEventListener("input", function(e) {
  urlFilter = e.target.value.trim().toLowerCase();
  renderList();
});

document.querySelectorAll(".method-chip").forEach(function(chip) {
  chip.addEventListener("click", function() {
    document.querySelectorAll(".method-chip").forEach(function(c) { c.classList.remove("active"); });
    chip.classList.add("active");
    methodFilter = chip.dataset.method;
    renderList();
  });
});

document.querySelectorAll(".status-chip").forEach(function(chip) {
  chip.addEventListener("click", function() {
    document.querySelectorAll(".status-chip").forEach(function(c) { c.classList.remove("active"); });
    chip.classList.add("active");
    statusFilter = chip.dataset.status;
    renderList();
  });
});

// Type filter chips — multi-select
// Clicking ALL clears all others. Clicking a specific type toggles it.
// If all deselected, falls back to showing everything.
document.querySelectorAll(".type-chip").forEach(function(chip) {
  chip.addEventListener("click", function() {
    var t = chip.dataset.type;
    if (t === "ALL") {
      // Reset — clear all selections
      typeFilters = {};
      document.querySelectorAll(".type-chip").forEach(function(c) { c.classList.remove("active"); });
      chip.classList.add("active");
    } else {
      // Toggle this type
      if (typeFilters[t]) {
        delete typeFilters[t];
        chip.classList.remove("active");
      } else {
        typeFilters[t] = true;
        chip.classList.add("active");
      }
      // Remove ALL highlight since we have specific selections
      var allChip = document.querySelector(".type-chip[data-type='ALL']");
      if (allChip) allChip.classList.remove("active");
      // If nothing selected, revert to ALL
      if (Object.keys(typeFilters).length === 0) {
        if (allChip) allChip.classList.add("active");
      }
    }
    renderList();
    var active = Object.keys(typeFilters);
    setStatus(active.length === 0 ? "Showing all types" : "Type filter: " + active.join(", "));
  });
});

// Scope filter chip (show in-scope only)
var _scopeFilterBtn = document.getElementById("btn-filter-scope");
if (_scopeFilterBtn) {
  _scopeFilterBtn.addEventListener("click", function() {
    scopeFilterOn = !scopeFilterOn;
    _scopeFilterBtn.classList.toggle("active", scopeFilterOn);
    renderList();
    if (scopeFilterOn && window.PhantomFeatures && !PhantomFeatures.scopeState.domains.length) {
      setStatus("⚠ No domains in scope — add domains in the Scope tab first");
    } else {
      setStatus(scopeFilterOn ? "Showing in-scope requests only" : "Showing all requests");
    }
  });
}

// ─── Capture Controls ─────────────────────────────────
document.getElementById("btn-clear").addEventListener("click", function() {
  sendBg({ type: "CLEAR_REQUESTS" });
});

document.getElementById("btn-pause").addEventListener("click", function() {
  captureActive = !captureActive;
  var btn = document.getElementById("btn-pause");
  var dot = document.getElementById("pulse-dot");
  var lbl = document.getElementById("capture-label");
  if (captureActive) {
    btn.textContent = "⏸ PAUSE";
    dot.classList.remove("paused");
    lbl.textContent = "CAPTURING";
    lbl.style.color = "var(--green)";
  } else {
    btn.textContent = "▶ RESUME";
    dot.classList.add("paused");
    lbl.textContent = "PAUSED";
    lbl.style.color = "var(--amber)";
  }
});

// ─── Filtering Logic ──────────────────────────────────
function getFiltered() {
  return allRequests.filter(function(req) {
    // Tab filter (standalone only)
    if (IS_STANDALONE) {
      var sel = document.getElementById("tab-target-select");
      if (sel && sel.value !== "all") {
        var tid = parseInt(sel.value, 10);
        if (isFinite(tid) && req.tabId !== tid) return false;
      }
    }

    // Scope filter — global hide mode (set in Scope tab)
    if (window.PhantomFeatures && !PhantomFeatures.scopeMatch(req.url)) {
      if (PhantomFeatures.scopeState.enabled && PhantomFeatures.scopeState.mode === "hide") return false;
    }

    // Scope filter — history tab "IN SCOPE ONLY" chip
    // Uses scopeMatchDomain so it works even when the global SCOPE toggle is OFF
    // (matches domains independently of DIM/HIDE mode, as documented)
    if (scopeFilterOn && window.PhantomFeatures) {
      if (!PhantomFeatures.scopeState.domains.length) {
        // No domains defined — let everything through
      } else if (typeof PhantomFeatures.scopeMatchDomain === "function"
          ? !PhantomFeatures.scopeMatchDomain(req.url)
          : !PhantomFeatures.scopeMatch(req.url)) {
        return false;
      }
    }

    // Method filter
    if (methodFilter !== "ALL" && req.method !== methodFilter) return false;

    // Type filter — multi-select
    if (Object.keys(typeFilters).length > 0) {
      var rt2 = (req.type || "other").toLowerCase();
      // Build a set of raw webRequest types that match selected chips
      var matched = false;
      var knownTypes2 = ["xmlhttprequest","script","stylesheet","main_frame","sub_frame","image","font","media","websocket"];
      if (typeFilters["xhr"]        && rt2 === "xmlhttprequest")                          matched = true;
      if (typeFilters["fetch"]      && rt2 === "xmlhttprequest")                          matched = true;
      if (typeFilters["script"]     && rt2 === "script")                                  matched = true;
      if (typeFilters["stylesheet"] && rt2 === "stylesheet")                              matched = true;
      if (typeFilters["document"]   && (rt2 === "main_frame" || rt2 === "sub_frame"))     matched = true;
      if (typeFilters["image"]      && rt2 === "image")                                   matched = true;
      if (typeFilters["font"]       && rt2 === "font")                                    matched = true;
      if (typeFilters["media"]      && rt2 === "media")                                   matched = true;
      if (typeFilters["websocket"]  && rt2 === "websocket")                               matched = true;
      if (typeFilters["other"]      && knownTypes2.indexOf(rt2) < 0)                      matched = true;
      if (!matched) return false;
    }

    // Bookmark filter
    if (bookmarkFilterOn && !bookmarkMap[req.id]) return false;

    // Status filter
    if (statusFilter !== "ALL") {
      var c = req.statusCode;
      if (statusFilter === "ERR" && req.status !== "error") return false;
      if (statusFilter === "2xx" && !(c >= 200 && c < 300)) return false;
      if (statusFilter === "3xx" && !(c >= 300 && c < 400)) return false;
      if (statusFilter === "4xx" && !(c >= 400 && c < 500)) return false;
      if (statusFilter === "5xx" && !(c >= 500 && c < 600)) return false;
    }

    // URL text filter
    if (urlFilter && req.url.toLowerCase().indexOf(urlFilter) < 0) return false;

    return true;
  });
}

// ─── Request List ─────────────────────────────────────
function renderList() {
  var list     = document.getElementById("request-list");
  var filtered = getFiltered();
  list.innerHTML = "";

  if (filtered.length === 0) {
    var wrap   = document.createElement("div");
    wrap.id    = "empty-state";
    var hex    = document.createElement("div");
    hex.className = "empty-hex";
    hex.textContent = "⬡";
    var p1     = document.createElement("p");
    p1.textContent = allRequests.length === 0 ? "Waiting for traffic…" : "No requests match filter";
    var p2     = document.createElement("p");
    p2.className = "empty-sub";
    p2.textContent = allRequests.length === 0
      ? "Requests made before opening this panel are not captured"
      : allRequests.length + " requests filtered out";
    var rb     = document.createElement("button");
    rb.className = "reload-nudge-btn";
    rb.innerHTML = "<span class='reload-icon'>⟳</span> RELOAD PAGE TO CAPTURE FROM START";
    rb.addEventListener("click", doReload);
    wrap.append(hex, p1, p2, rb);
    list.appendChild(wrap);
    updateCount();
    return;
  }

  filtered.forEach(function(req) { list.appendChild(makeRow(req)); });
  updateCount();
}

function makeRow(req) {
  var row = document.createElement("div");
  row.className = "request-row";
  row.dataset.id = req.id;
  if (req.id === selectedRequestId) row.classList.add("selected");

  var p   = parseURL(req.url);
  var sc  = statusClass(req);
  var dur = req.duration ? fmtDuration(req.duration) : "—";
  var st  = req.status === "error" ? "ERR" : (req.statusCode || "…");

  var m = el("span", "row-method " + (METHOD_CSS[req.method] || "method-OTHER"), req.method);
  var s = el("span", "row-status " + sc, String(st));
  var u = document.createElement("span");
  u.className = "row-url"; u.title = req.url;
  u.appendChild(el("span","row-url-domain", p.host));
  u.appendChild(txt(p.path));

  // Highlight flags
  var flagsSpan = document.createElement("span");
  flagsSpan.className = "row-flags";
  // Note / tag indicator
  if (window.PhantomAdvanced && PhantomAdvanced.getNote) {
    var noteInfo = PhantomAdvanced.getNote(req.id);
    if (noteInfo && (noteInfo.note || (noteInfo.tags && noteInfo.tags.length))) {
      var nd = document.createElement("span");
      nd.className = "row-note-dot";
      nd.title = noteInfo.note || (noteInfo.tags || []).join(", ");
      flagsSpan.appendChild(nd);
      if (noteInfo.tags && noteInfo.tags.length) {
        var tg = document.createElement("span");
        tg.className = "row-tags";
        tg.textContent = noteInfo.tags.slice(0, 2).join(",");
        flagsSpan.appendChild(tg);
      }
    }
  }
  if (window.PhantomFeatures) {
    var hits = PhantomFeatures.getHighlights(req);
    // Show top 2 badges to keep row clean
    hits.slice(0, 2).forEach(function(rule) {
      flagsSpan.appendChild(PhantomFeatures.makeHighlightBadge(rule));
    });
    if (hits.length > 2) {
      var more = document.createElement("span");
      more.className = "highlight-badge";
      more.textContent = "+" + (hits.length - 2);
      more.style.cssText = "color:var(--text-dim);border:1px solid var(--border);border-radius:2px;font-family:var(--font-ui);font-size:9px;padding:1px 4px;";
      flagsSpan.appendChild(more);
    }
    // Row-level highlight glow
    if (hits.length) {
      var topRule = hits[0];
      if (topRule.id === "admin" || topRule.id === "sensitive" || topRule.id === "server-error" || topRule.id === "sqli-hint") {
        row.classList.add("hl-security");
      } else if (topRule.id === "jwt" || topRule.id === "auth" || topRule.id === "apikey") {
        row.classList.add("hl-auth");
      } else {
        row.classList.add("hl-info");
      }
    }
    // Scope dimming
    if (!PhantomFeatures.scopeMatch(req.url) && PhantomFeatures.scopeState.enabled) {
      row.classList.add("out-of-scope");
    }
  }

  var t = el("span","row-type", req.type || "");
  var d = el("span","row-time", dur);

  // Bookmark color strip
  var bm = bookmarkMap[req.id];
  if (bm) {
    row.style.borderLeft = "3px solid " + bm.color;
    row.style.background = bm.color + "10";
    if (bm.label) row.title = "Bookmark: " + bm.label;
  } else {
    row.style.borderLeft = "3px solid transparent";
  }

  row.append(m, s, u, flagsSpan, t, d);
  row.addEventListener("click", function() { selectReq(req.id); });

  // Right-click → bookmark context menu
  row.addEventListener("contextmenu", function(e) {
    e.preventDefault();
    showBookmarkMenu(req.id, e.clientX, e.clientY);
  });

  return row;
}

function appendRow(req) {
  var list = document.getElementById("request-list");
  var emp  = list.querySelector("#empty-state");
  if (emp) emp.remove();
  if (!matchFilter(req)) return;
  list.appendChild(makeRow(req));
}

function updateRow(req) {
  var old = document.querySelector(".request-row[data-id=\"" + CSS.escape(req.id) + "\"]");
  if (old) {
    old.replaceWith(makeRow(req));
    if (selectedRequestId === req.id) renderDetail(req);
  }
}

function matchFilter(req) {
  if (methodFilter !== "ALL" && req.method !== methodFilter) return false;
  if (urlFilter && req.url.toLowerCase().indexOf(urlFilter) < 0) return false;
  return true;
}

function updateCount() {
  var f = getFiltered();
  document.getElementById("request-count").textContent =
    f.length + (f.length !== allRequests.length ? "/" + allRequests.length : "") + " requests";
}

// ─── Detail Pane ──────────────────────────────────────
function selectReq(id) {
  selectedRequestId = id;
  document.querySelectorAll(".request-row").forEach(function(r) {
    r.classList.toggle("selected", r.dataset.id === id);
  });
  var req = allRequests.find(function(r) { return r.id === id; });
  if (req) renderDetail(req);
  if (window.PhantomAdvanced && PhantomAdvanced.fillNoteEditor) {
    PhantomAdvanced.fillNoteEditor(id);
  }
}

function showDetailEmpty() {
  document.getElementById("detail-empty").classList.remove("hidden");
  document.getElementById("detail-content").classList.add("hidden");
}

function renderDetail(req) {
  document.getElementById("detail-empty").classList.add("hidden");
  document.getElementById("detail-content").classList.remove("hidden");

  var badge = document.getElementById("detail-method-badge");
  badge.textContent = req.method;
  badge.className = METHOD_CSS[req.method] || "method-OTHER";
  badge.style.borderColor = methodColor(req.method);
  document.getElementById("detail-url-text").textContent = req.url;

  var sc = statusClass(req);
  var sm = document.getElementById("meta-status");
  sm.textContent = req.status === "error" ? "ERROR: " + (req.error||"") : (req.statusCode||"Pending");
  sm.style.color = sc==="status-2xx"?"var(--green)":sc==="status-4xx"?"var(--amber)":sc==="status-5xx"?"var(--red)":"var(--text-secondary)";
  document.getElementById("meta-duration").textContent = req.duration ? fmtDuration(req.duration) : "—";
  document.getElementById("meta-type").textContent = req.type || "—";
  document.getElementById("meta-size").textContent = "";

  renderKV("req-headers-table", req.requestHeaders || {});
  document.getElementById("req-body-content").textContent = req.requestBody || "(no body)";
  renderKV("res-headers-table", req.responseHeaders || {});
  document.getElementById("raw-content").textContent = buildRaw(req);

  // Reset detail sub-tabs to first tab
  document.querySelectorAll(".dtab").forEach(function(b) { b.classList.remove("active"); });
  document.querySelectorAll(".dtab-pane").forEach(function(p) { p.classList.add("hidden"); });
  document.querySelector(".dtab").classList.add("active");
  document.querySelector(".dtab-pane").classList.remove("hidden");

  // Re-init detail tab clicks
  document.querySelectorAll(".dtab").forEach(function(btn) {
    btn.onclick = function() {
      document.querySelectorAll(".dtab").forEach(function(b) { b.classList.remove("active"); });
      document.querySelectorAll(".dtab-pane").forEach(function(p) { p.classList.add("hidden"); });
      btn.classList.add("active");
      var pane = document.getElementById("dtab-" + btn.dataset.dtab);
      if (pane) pane.classList.remove("hidden");
      if (btn.dataset.dtab === "res-pretty") fetchDetailPretty(req);
    };
  });
}

function renderKV(id, obj) {
  var c = document.getElementById(id);
  c.innerHTML = "";
  var keys = Object.keys(obj).filter(function(k) {
    return Object.prototype.hasOwnProperty.call(obj, k);
  });
  if (!keys.length) {
    var d = document.createElement("div");
    d.style.cssText = "color:var(--text-dim);padding:10px;font-family:var(--font-ui)";
    d.textContent = "No headers";
    c.appendChild(d);
    return;
  }
  keys.forEach(function(k) {
    var row = document.createElement("div");
    row.className = "kv-row";
    row.appendChild(el("span","kv-key", k));
    row.appendChild(el("span","kv-val", obj[k]));
    c.appendChild(row);
  });
}

// ─── Detail Pretty Tab ────────────────────────────────
function fetchDetailPretty(req) {
  var out = document.getElementById("detail-res-pretty");
  var tb  = document.getElementById("detail-pretty-toolbar");
  if (!out) return;
  out.classList.remove("pretty-json");
  out.textContent = "Fetching…";
  if (tb) tb.querySelector("span").textContent = "FETCHING…";
  sendBg({
    type: "SEND_REPEATER",
    request: {
      id: "dp_" + req.id,
      method: req.method,
      url: req.url,
      requestHeaders: req.requestHeaders || {},
      requestBody: req.requestBody || null
    }
  });
}

function showDetailPrettyResult(result) {
  var out = document.getElementById("detail-res-pretty");
  var tb  = document.getElementById("detail-pretty-toolbar");
  if (!out) return;

  if (!result.success) {
    out.classList.remove("pretty-json");
    out.textContent = "Error: " + result.error;
    if (tb) tb.querySelector("span").textContent = "FETCH FAILED";
    return;
  }

  var body = result.body || "(empty)";
  if (tb) {
    tb.querySelector("span").textContent =
      result.statusCode + " " + (result.statusText||"") +
      " · " + fmtDuration(result.duration) + " · " + fmtSize(result.size||0);
  }

  renderPrettyInto(out, body);

  var cpBtn = document.getElementById("btn-detail-copy-pretty");
  if (cpBtn) cpBtn.onclick = function() {
    navigator.clipboard.writeText(body).then(function() { setStatus("Copied ✓"); });
  };
}

// ─── Send to Repeater ─────────────────────────────────
document.getElementById("btn-send-repeater").addEventListener("click", function() {
  var req = allRequests.find(function(r) { return r.id === selectedRequestId; });
  if (!req) return;
  createSession(req);
  switchTab("repeater");
});

document.getElementById("btn-copy-curl").addEventListener("click", function() {
  var req = allRequests.find(function(r) { return r.id === selectedRequestId; });
  if (!req) return;
  navigator.clipboard.writeText(buildCurl(req))
    .then(function() { setStatus("cURL copied ✓"); });
});

function switchTab(name) {
  document.querySelectorAll(".tab-btn").forEach(function(b) { b.classList.remove("active"); });
  document.querySelectorAll(".tab-pane").forEach(function(p) { p.classList.add("hidden"); });
  var btn = document.querySelector("[data-tab='" + name + "']");
  if (btn) btn.classList.add("active");
  var pane = document.getElementById("tab-" + name);
  if (pane) pane.classList.remove("hidden");
  if (window.PhantomAdvanced && PhantomAdvanced.onTabActivated) {
    PhantomAdvanced.onTabActivated(name);
  }
}

// ─── Cookie helpers ───────────────────────────────────
/**
 * Parse a Cookie header string into [{name, value}, ...].
 * Handles "a=1; b=2" and trims whitespace. Values may contain '='.
 */
function parseCookieHeader(str) {
  if (!str || typeof str !== "string") return [];
  return str.split(";").map(function(part) {
    part = part.trim();
    if (!part) return null;
    var eq = part.indexOf("=");
    if (eq < 0) return { name: part, value: "" };
    return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
  }).filter(function(c) { return c && c.name; });
}

function cookiesToHeader(list) {
  if (!list || !list.length) return "";
  return list
    .filter(function(c) { return c && c.name; })
    .map(function(c) { return c.name + "=" + (c.value == null ? "" : c.value); })
    .join("; ");
}

/**
 * Extract cookies for a session from request headers (Cookie header)
 * and optional explicit cookies array.
 */
function extractCookiesFromReq(req) {
  if (!req) return [];
  if (req.cookies && Array.isArray(req.cookies) && req.cookies.length) {
    return req.cookies.map(function(c) {
      return { name: c.name || "", value: c.value == null ? "" : String(c.value) };
    });
  }
  var h = req.requestHeaders || {};
  var keys = Object.keys(h);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === "cookie") {
      return parseCookieHeader(h[keys[i]]);
    }
  }
  return [];
}

// ─── Repeater Sessions ────────────────────────────────
function createSession(req) {
  var id = ++sessionCounter;
  var h  = {};
  if (req && req.requestHeaders) Object.assign(h, req.requestHeaders);
  var cookies = extractCookiesFromReq(req);
  // Keep headers and cookies in sync: if we have a Cookie header and no pairs, parse it
  if (!cookies.length) {
    Object.keys(h).forEach(function(k) {
      if (k.toLowerCase() === "cookie") cookies = parseCookieHeader(h[k]);
    });
  }
  repeaterSessions.push({
    id: id,
    label: "#" + id + " " + (req ? req.method : "NEW"),
    method: req ? validMethod(req.method) : "GET",
    url: req ? req.url : "",
    headers: h,
    cookies: cookies,
    body: req ? (req.requestBody || "") : "",
    rawContent: req ? buildRaw(req) : "",
    response: null
  });
  renderSessionTabs();
  activateSession(id);
  // If sent from history without a Cookie header, try loading browser jar
  if (req && req.url && !cookies.length) {
    requestBrowserCookies(id, req.url);
  }
}

function renderSessionTabs() {
  var bar = document.getElementById("repeater-session-tabs");
  bar.innerHTML = "";
  repeaterSessions.forEach(function(s) {
    var tab = document.createElement("div");
    tab.className = "session-tab" + (s.id === activeSessionId ? " active" : "");
    tab.appendChild(txt(s.label));
    var x = document.createElement("span");
    x.className = "close-tab";
    x.dataset.id = String(s.id);
    x.textContent = "✕";
    tab.appendChild(x);
    tab.addEventListener("click", function(e) {
      if (e.target.classList.contains("close-tab")) {
        var n = parseInt(e.target.dataset.id, 10);
        if (isFinite(n)) closeSession(n);
      } else { activateSession(s.id); }
    });
    bar.appendChild(tab);
  });
}

function activateSession(id) {
  activeSessionId = id;
  renderSessionTabs();
  var s = repeaterSessions.find(function(x) { return x.id === id; });
  if (s) loadSession(s);
}

function closeSession(id) {
  repeaterSessions = repeaterSessions.filter(function(s) { return s.id !== id; });
  if (activeSessionId === id) {
    activeSessionId = repeaterSessions.length ? repeaterSessions[repeaterSessions.length-1].id : null;
  }
  renderSessionTabs();
  if (activeSessionId) activateSession(activeSessionId);
  else clearEditor();
}

function loadSession(s) {
  document.getElementById("rep-method").value = s.method;
  document.getElementById("rep-url").value    = s.url;
  document.getElementById("rep-body").value   = s.body;
  document.getElementById("rep-raw").value    = s.rawContent;
  var hc = document.getElementById("headers-editor-rows");
  hc.innerHTML = "";
  Object.keys(s.headers).forEach(function(k) {
    if (!Object.prototype.hasOwnProperty.call(s.headers,k)) return;
    if (k.toLowerCase()==="host" || k.toLowerCase()==="content-length") return;
    // Cookie is edited in the COOKIES tab — still show a read-only-ish row if present
    // but prefer the cookies array as source of truth (synced on save/send)
    addHdrRow(k, s.headers[k]);
  });
  // Cookies tab
  if (!s.cookies) s.cookies = [];
  renderCookieRows(s.cookies);
  if (s.response) showRepResponse(s.response);
  else clearRepResponse();
}

function saveSession() {
  var s = repeaterSessions.find(function(x) { return x.id === activeSessionId; });
  if (!s) return;
  s.method     = validMethod(document.getElementById("rep-method").value);
  s.url        = document.getElementById("rep-url").value;
  s.body       = document.getElementById("rep-body").value;
  s.rawContent = document.getElementById("rep-raw").value;
  s.headers    = collectHdrs();
  s.cookies    = collectCookies();
  // Prefer COOKIES tab when it has pairs; otherwise adopt Cookie header from HEADERS
  if (s.cookies.length) {
    syncCookieHeader(s);
  } else {
    Object.keys(s.headers).forEach(function(k) {
      if (k.toLowerCase() === "cookie") {
        s.cookies = parseCookieHeader(s.headers[k]);
      }
    });
  }
}

/**
 * Write cookies array into the Cookie request header (or remove it if empty).
 */
function syncCookieHeader(s) {
  if (!s.headers) s.headers = {};
  // Drop any existing Cookie key (case-insensitive)
  Object.keys(s.headers).forEach(function(k) {
    if (k.toLowerCase() === "cookie") delete s.headers[k];
  });
  var hdr = cookiesToHeader(s.cookies);
  if (hdr) s.headers["Cookie"] = hdr;

  // Also refresh the Cookie row in the headers editor if visible
  var found = false;
  document.querySelectorAll("#headers-editor-rows .header-row").forEach(function(row) {
    var ki = row.querySelector(".header-key");
    if (ki && ki.value.trim().toLowerCase() === "cookie") {
      found = true;
      if (hdr) {
        row.querySelector(".header-val").value = hdr;
      } else {
        row.remove();
      }
    }
  });
  if (hdr && !found) {
    // Don't auto-add Cookie to headers UI while user is on cookies tab —
    // it will appear next loadSession. Keep data model consistent only.
  }
}

function clearEditor() {
  document.getElementById("rep-method").value = "GET";
  document.getElementById("rep-url").value    = "";
  document.getElementById("rep-body").value   = "";
  document.getElementById("rep-raw").value    = "";
  document.getElementById("headers-editor-rows").innerHTML = "";
  var cr = document.getElementById("cookies-editor-rows");
  if (cr) cr.innerHTML = "";
  clearRepResponse();
}

document.getElementById("btn-new-repeater").addEventListener("click", function() { createSession(null); });

// ─── Header Editor ────────────────────────────────────
function addHdrRow(k, v) {
  var row = document.createElement("div");
  row.className = "header-row";
  var ki = document.createElement("input");
  ki.type="text"; ki.className="header-key"; ki.placeholder="Header-Name"; ki.spellcheck=false; ki.value=k||"";
  var vi = document.createElement("input");
  vi.type="text"; vi.className="header-val"; vi.placeholder="value"; vi.spellcheck=false; vi.value=v||"";
  var db = document.createElement("button");
  db.className="btn-del-header"; db.title="Remove"; db.textContent="✕";
  db.addEventListener("click", function() { row.remove(); });
  row.append(ki, vi, db);
  document.getElementById("headers-editor-rows").appendChild(row);
}

document.getElementById("btn-add-header").addEventListener("click", function() { addHdrRow("",""); });

function collectHdrs() {
  var h = {};
  document.querySelectorAll("#headers-editor-rows .header-row").forEach(function(row) {
    var k = row.querySelector(".header-key").value.trim();
    var v = row.querySelector(".header-val").value.trim();
    if (k) h[k] = v;
  });
  return h;
}

// ─── Cookie Editor ────────────────────────────────────
function addCookieRow(name, value) {
  var container = document.getElementById("cookies-editor-rows");
  if (!container) return;
  var row = document.createElement("div");
  row.className = "cookie-row";
  var ni = document.createElement("input");
  ni.type = "text"; ni.className = "cookie-name"; ni.placeholder = "name";
  ni.spellcheck = false; ni.value = name || "";
  var vi = document.createElement("input");
  vi.type = "text"; vi.className = "cookie-val"; vi.placeholder = "value";
  vi.spellcheck = false; vi.value = value == null ? "" : value;
  var db = document.createElement("button");
  db.className = "btn-del-header"; db.title = "Remove"; db.textContent = "✕";
  db.addEventListener("click", function() { row.remove(); });
  row.append(ni, vi, db);
  container.appendChild(row);
}

function renderCookieRows(list) {
  var container = document.getElementById("cookies-editor-rows");
  if (!container) return;
  container.innerHTML = "";
  if (list && list.length) {
    list.forEach(function(c) { addCookieRow(c.name, c.value); });
  }
}

function collectCookies() {
  var out = [];
  document.querySelectorAll("#cookies-editor-rows .cookie-row").forEach(function(row) {
    var n = row.querySelector(".cookie-name");
    var v = row.querySelector(".cookie-val");
    if (!n) return;
    var name = n.value.trim();
    if (!name) return;
    out.push({ name: name, value: v ? v.value : "" });
  });
  return out;
}

var _btnAddCookie = document.getElementById("btn-add-cookie");
if (_btnAddCookie) {
  _btnAddCookie.addEventListener("click", function() { addCookieRow("", ""); });
}

var _btnLoadCookies = document.getElementById("btn-load-browser-cookies");
if (_btnLoadCookies) {
  _btnLoadCookies.addEventListener("click", function() {
    var s = repeaterSessions.find(function(x) { return x.id === activeSessionId; });
    var url = document.getElementById("rep-url").value.trim() || (s && s.url) || "";
    if (!url) {
      setStatus("Set a URL first to load browser cookies");
      return;
    }
    requestBrowserCookies(activeSessionId, url, true);
  });
}

/** Pending cookie loads: requestId → { sessionId, merge, url } */
var _cookieRequests = {};
var _cookieReqCounter = 0;

function requestBrowserCookies(sessionId, url, merge) {
  var rid = "ck_" + (++_cookieReqCounter);
  _cookieRequests[rid] = { sessionId: sessionId, merge: !!merge, url: url };
  sendBg({ type: "GET_COOKIES", url: url, requestId: rid });
  setStatus("Loading browser cookies for " + url + "…");
}

function onCookiesResult(msg) {
  var meta = msg.requestId ? _cookieRequests[msg.requestId] : null;
  if (msg.requestId) delete _cookieRequests[msg.requestId];
  var sessionId = meta ? meta.sessionId : activeSessionId;
  var merge = meta ? meta.merge : true;
  var s = repeaterSessions.find(function(x) { return x.id === sessionId; });
  if (!s) return;

  var incoming = (msg.cookies || []).map(function(c) {
    return { name: c.name, value: c.value == null ? "" : String(c.value) };
  });

  if (!incoming.length) {
    if (merge) setStatus("No browser cookies found for this URL");
    return;
  }

  if (merge && s.cookies && s.cookies.length) {
    // Merge by name (incoming overwrites)
    var map = {};
    s.cookies.forEach(function(c) { if (c.name) map[c.name] = c.value; });
    incoming.forEach(function(c) { if (c.name) map[c.name] = c.value; });
    s.cookies = Object.keys(map).map(function(n) { return { name: n, value: map[n] }; });
  } else {
    s.cookies = incoming;
  }

  syncCookieHeader(s);
  if (activeSessionId === sessionId) {
    renderCookieRows(s.cookies);
    // Refresh Cookie header row in headers editor
    var hdr = cookiesToHeader(s.cookies);
    var updated = false;
    document.querySelectorAll("#headers-editor-rows .header-row").forEach(function(row) {
      var ki = row.querySelector(".header-key");
      if (ki && ki.value.trim().toLowerCase() === "cookie") {
        row.querySelector(".header-val").value = hdr;
        updated = true;
      }
    });
    if (hdr && !updated) addHdrRow("Cookie", hdr);
  }
  setStatus("Loaded " + incoming.length + " cookie" + (incoming.length !== 1 ? "s" : "") + " ✓");
}

// ─── Send Request ─────────────────────────────────────
document.getElementById("btn-send-req").addEventListener("click", doSend);

function doSend() {
  var btn = document.getElementById("btn-send-req");
  btn.disabled = true;
  btn.innerHTML = "<span class='spinner'></span>";
  saveSession();
  var s = repeaterSessions.find(function(x) { return x.id === activeSessionId; });
  if (!s) { btn.disabled=false; btn.textContent="▶ SEND"; return; }

  var h = Object.assign({}, s.headers);
  var activeEtab = document.querySelector(".rep-etab.active");
  if (activeEtab && activeEtab.dataset.etab === "rep-body-editor" && s.body) {
    h["Content-Type"] = document.getElementById("body-content-type").value;
  }
  // Ensure Cookie header reflects cookies tab
  var cookieHdr = cookiesToHeader(s.cookies);
  Object.keys(h).forEach(function(k) {
    if (k.toLowerCase() === "cookie") delete h[k];
  });
  if (cookieHdr) h["Cookie"] = cookieHdr;

  var outbound = {
    id: activeSessionId,
    method: s.method,
    url: s.url,
    requestHeaders: h,
    requestBody: s.body || null,
    cookies: s.cookies || []
  };
  // Match & replace rules (Tools tab) — applied before network send
  if (window.PhantomAdvanced && PhantomAdvanced.applyMatchReplace) {
    outbound = PhantomAdvanced.applyMatchReplace(outbound);
  }
  // Client-side SSRF guard (worker re-validates)
  if (window.PhantomSecurity) {
    var uerr = PhantomSecurity.validateHttpUrl(outbound.url);
    if (uerr) {
      btn.disabled = false;
      btn.textContent = "▶ SEND";
      setStatus("Blocked: " + uerr);
      return;
    }
  }

  sendBg({ type: "SEND_REPEATER", request: outbound });
  btn.disabled=false; btn.textContent="▶ SEND";
  setStatus("Sending " + outbound.method + " " + outbound.url + "…");
}

function onRepeaterResponse(sid, result) {
  var s = repeaterSessions.find(function(x) { return x.id === sid; });
  if (s) s.response = result;
  if (activeSessionId === sid) showRepResponse(result);
  setStatus(result.success
    ? "Response: " + result.statusCode + " · " + fmtDuration(result.duration) + " · " + fmtSize(result.size||0)
    : "Failed: " + result.error);
}

// ─── Response Display ─────────────────────────────────
function showRepResponse(result) {
  document.getElementById("response-meta-bar").classList.remove("hidden");
  var se = document.getElementById("rep-meta-status");
  var c  = result.statusCode || 0;
  se.textContent = result.success ? c+" "+(result.statusText||"") : "ERROR: "+result.error;
  se.style.color = c>=200&&c<300?"var(--green)":c>=400&&c<500?"var(--amber)":c>=500?"var(--red)":"var(--text-secondary)";
  document.getElementById("rep-meta-duration").textContent = fmtDuration(result.duration);
  document.getElementById("rep-meta-size").textContent     = fmtSize(result.size||0);

  lastRespBody = result.body || result.error || "(empty)";
  lastRespType = (result.responseHeaders && result.responseHeaders["content-type"]) || "";

  var acts = document.getElementById("rep-res-tab-actions");
  if (acts) acts.classList.add("visible");

  var pb = document.getElementById("btn-view-pretty");
  if (pb) {
    var can = isJson(lastRespType)||isXml(lastRespType)||looksJson(lastRespBody)||looksXml(lastRespBody);
    pb.disabled = !can;
    pb.style.opacity = can ? "1" : "0.35";
  }

  setViewMode("raw");
  document.getElementById("rep-response-empty").classList.add("hidden");
  var be = document.getElementById("rep-response-body");
  be.classList.remove("hidden");
  be.textContent = lastRespBody;

  if (result.responseHeaders) renderKV("rep-res-headers-table", result.responseHeaders);
}

function clearRepResponse() {
  document.getElementById("response-meta-bar").classList.add("hidden");
  document.getElementById("rep-response-empty").classList.remove("hidden");
  document.getElementById("rep-response-body").classList.add("hidden");
  document.getElementById("rep-res-headers-table").innerHTML = "";
  var acts = document.getElementById("rep-res-tab-actions");
  if (acts) acts.classList.remove("visible");
  lastRespBody = "";
}

// ─── Pretty Print ─────────────────────────────────────
function isJson(ct)    { return ct.indexOf("json") >= 0; }
function isXml(ct)     { return ct.indexOf("xml") >= 0 || ct.indexOf("html") >= 0; }
function looksJson(s)  { if (!s) return false; var t=s.trimLeft(); return t[0]==="{"||t[0]==="["; }
function looksXml(s)   { if (!s) return false; return s.trimLeft()[0]==="<"; }

function setViewMode(mode) {
  var be  = document.getElementById("rep-response-body");
  var rb  = document.getElementById("btn-view-raw");
  var pb  = document.getElementById("btn-view-pretty");
  if (!be) return;
  if (rb) rb.classList.toggle("active", mode==="raw");
  if (pb) pb.classList.toggle("active", mode==="pretty");
  if (mode === "pretty") {
    renderPrettyInto(be, lastRespBody);
  } else {
    be.classList.remove("pretty-json");
    be.innerHTML = "";
    be.textContent = lastRespBody;
  }
}

function renderPrettyInto(el, body) {
  if (looksJson(body)) {
    try {
      var p = JSON.stringify(JSON.parse(body), null, 2);
      el.classList.add("pretty-json");
      el.innerHTML = "";
      el.appendChild(highlightJson(p));
      return;
    } catch(e) {}
  }
  if (looksXml(body)) {
    try { el.classList.remove("pretty-json"); el.textContent = fmtXml(body); return; } catch(e) {}
  }
  el.classList.remove("pretty-json");
  el.textContent = body;
}

function highlightJson(s) {
  var f   = document.createDocumentFragment();
  var re  = /("(?:[^"\\]|\\.)*"(?:\s*:)?)|(\b(?:true|false)\b)|(\bnull\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}\[\],])/g;
  var last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) f.appendChild(txt(s.slice(last, m.index)));
    var sp = document.createElement("span");
    if      (m[1]) sp.className = m[0].trimRight().endsWith(":") ? "json-key" : "json-string";
    else if (m[2]) sp.className = "json-bool";
    else if (m[3]) sp.className = "json-null";
    else if (m[4]) sp.className = "json-number";
    else           sp.className = "json-punct";
    sp.textContent = m[0];
    f.appendChild(sp);
    last = re.lastIndex;
  }
  if (last < s.length) f.appendChild(txt(s.slice(last)));
  return f;
}

function fmtXml(xml) {
  var out = "", indent = 0, pad = "  ";
  xml.replace(/>\s*</g, ">\n<").split("\n").forEach(function(node) {
    node = node.trim();
    if (!node) return;
    if (/^<\/\w/.test(node)) indent--;
    out += pad.repeat(Math.max(0,indent)) + node + "\n";
    if (/^<\w[^>]*[^/]>.*$/.test(node) && !/^<.+\/>/.test(node)) indent++;
  });
  return out.trim();
}

// Response viewer buttons
var _rb = document.getElementById("btn-view-raw");
var _pb = document.getElementById("btn-view-pretty");
var _cb = document.getElementById("btn-copy-response");
var _wb = document.getElementById("btn-wrap-toggle");

if (_rb) _rb.addEventListener("click", function() { setViewMode("raw"); });
if (_pb) _pb.addEventListener("click", function() { if (!_pb.disabled) setViewMode("pretty"); });
if (_cb) _cb.addEventListener("click", function() {
  if (lastRespBody) navigator.clipboard.writeText(lastRespBody).then(function() { setStatus("Copied ✓"); });
});
if (_wb) _wb.addEventListener("click", function() {
  var be = document.getElementById("rep-response-body");
  wrapOn = !wrapOn;
  if (wrapOn) {
    be.classList.remove("wrap-off"); be.classList.add("wrap-on");
    _wb.style.color = "var(--cyan)"; _wb.style.borderColor = "var(--cyan-dim)";
  } else {
    be.classList.remove("wrap-on"); be.classList.add("wrap-off");
    _wb.style.color = ""; _wb.style.borderColor = "";
  }
});

// ─── Repeater sub-tabs ────────────────────────────────
document.querySelectorAll(".rep-etab").forEach(function(btn) {
  btn.addEventListener("click", function() {
    document.querySelectorAll(".rep-etab").forEach(function(b) { b.classList.remove("active"); });
    document.querySelectorAll(".rep-etab-pane").forEach(function(p) { p.classList.add("hidden"); });
    btn.classList.add("active");
    var pane = document.getElementById("rep-etab-" + btn.dataset.etab);
    if (pane) pane.classList.remove("hidden");
  });
});
document.querySelectorAll(".rep-rtab").forEach(function(btn) {
  btn.addEventListener("click", function() {
    document.querySelectorAll(".rep-rtab").forEach(function(b) { b.classList.remove("active"); });
    document.querySelectorAll(".rep-rtab-pane").forEach(function(p) { p.classList.add("hidden"); });
    btn.classList.add("active");
    var pane = document.getElementById("rep-rtab-" + btn.dataset.rtab);
    if (pane) pane.classList.remove("hidden");
  });
});

document.getElementById("btn-format-body").addEventListener("click", function() {
  var ta = document.getElementById("rep-body");
  try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); }
  catch(e) { setStatus("⚠ Invalid JSON"); }
});

// ─── Decoder ──────────────────────────────────────────
document.getElementById("btn-decode").addEventListener("click", runDecoder);
document.getElementById("btn-decode-chain").addEventListener("click", function() {
  document.getElementById("decoder-input").value  = document.getElementById("decoder-output").value;
  document.getElementById("decoder-output").value = "";
});
document.getElementById("btn-copy-output").addEventListener("click", function() {
  navigator.clipboard.writeText(document.getElementById("decoder-output").value)
    .then(function() { setStatus("Copied ✓"); });
});
document.getElementById("decode-action").addEventListener("change", function(e) {
  document.getElementById("jwt-inspector").classList.toggle("hidden", e.target.value !== "jwt-decode");
});

function runDecoder() {
  var inp = document.getElementById("decoder-input").value;
  var act = document.getElementById("decode-action").value;
  var out = "";
  try {
    if      (act==="b64-decode")  out = atob(inp.trim());
    else if (act==="b64-encode")  out = btoa(unescape(encodeURIComponent(inp)));
    else if (act==="url-decode")  out = decodeURIComponent(inp);
    else if (act==="url-encode")  out = encodeURIComponent(inp);
    else if (act==="html-decode") out = (window.PhantomSecurity ? PhantomSecurity.htmlDecode(inp) : inp);
    else if (act==="html-encode") out = (window.PhantomSecurity ? PhantomSecurity.htmlEncode(inp) : inp.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"));
    else if (act==="hex-encode")  out = Array.from(inp).map(function(c){return c.charCodeAt(0).toString(16).padStart(2,"0");}).join("");
    else if (act==="hex-decode") {
      var pairs = inp.replace(/\s/g,"").match(/.{2}/g);
      if (!pairs) throw new Error("Invalid hex");
      out = pairs.map(function(b){return String.fromCharCode(parseInt(b,16));}).join("");
    }
    else if (act==="json-format") out = JSON.stringify(JSON.parse(inp), null, 2);
    else if (act==="jwt-decode")  out = decodeJWT(inp);
    else if (act==="sha256") {
      sha256(inp).then(function(h) {
        document.getElementById("decoder-output").value = h;
        setStatus("SHA-256 done ✓");
      });
      return;
    }
    document.getElementById("decoder-output").value = out;
    setStatus("Transform applied ✓");
  } catch(e) {
    document.getElementById("decoder-output").value = "ERROR: " + e.message;
    setStatus("Error: " + e.message);
  }
}

function decodeJWT(token) {
  var parts = token.trim().split(".");
  if (parts.length !== 3) throw new Error("Expected 3 parts");
  function b64(s) { s=s.replace(/-/g,"+").replace(/_/g,"/"); while(s.length%4)s+="="; return JSON.parse(atob(s)); }
  var hdr  = b64(parts[0]);
  var pay  = b64(parts[1]);
  document.getElementById("jwt-header").textContent  = JSON.stringify(hdr, null, 2);
  document.getElementById("jwt-payload").textContent = JSON.stringify(pay, null, 2);
  document.getElementById("jwt-sig").textContent     = parts[2];
  document.getElementById("jwt-inspector").classList.remove("hidden");
  var alg = String(hdr.alg||"unknown");
  document.getElementById("jwt-alg-name").textContent = alg;
  document.getElementById("jwt-alg-warning").classList.toggle("hidden", alg!=="none"&&alg!=="HS256");
  return "Header:\n"+JSON.stringify(hdr,null,2)+"\n\nPayload:\n"+JSON.stringify(pay,null,2)+"\n\nSig:\n"+parts[2];
}

async function sha256(s) {
  var b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(function(x){return x.toString(16).padStart(2,"0");}).join("");
}

// ─── Reload Handler ───────────────────────────────────
function doReload() {
  if (IS_STANDALONE) {
    var sel = document.getElementById("tab-target-select");
    var val = sel ? sel.value : "all";
    if (!sel || val === "all") {
      setStatus("⚠ Select a specific tab from the dropdown first");
      if (sel) { sel.style.borderColor="var(--amber)"; setTimeout(function(){sel.style.borderColor="";},2000); }
      return;
    }
    var tid = parseInt(val, 10);
    if (!isFinite(tid)) return;
    chrome.tabs.reload(tid, {}, function() {
      allRequests = allRequests.filter(function(r){return r.tabId!==tid;});
      renderList();
      setStatus("Tab reloading — capturing from start…");
    });
  } else {
    // DevTools mode
    chrome.devtools.inspectedWindow.reload({});
    allRequests = [];
    renderList();
    showDetailEmpty();
    setStatus("Page reloading — capturing from start…");
  }
}

// ─── Standalone UI ────────────────────────────────────
function initStandalone() {
  document.body.classList.add("standalone");
  var bar = document.getElementById("standalone-tab-bar");
  if (bar) bar.classList.remove("hidden");
  populateTabs();
  var rb = document.getElementById("btn-refresh-tabs");
  if (rb) rb.addEventListener("click", populateTabs);
  var sel = document.getElementById("tab-target-select");
  if (sel) sel.addEventListener("change", function() {
    renderList();
    setStatus(sel.value==="all" ? "Monitoring all tabs" : "Monitoring: "+sel.options[sel.selectedIndex].text);
  });
}

function populateTabs() {
  var sel = document.getElementById("tab-target-select");
  if (!sel) return;
  chrome.tabs.query({}, function(tabs) {
    var prev = sel.value;
    sel.innerHTML = "";
    var ao = document.createElement("option"); ao.value="all"; ao.textContent="All Tabs"; sel.appendChild(ao);
    tabs.filter(function(t){return t.url&&(t.url.indexOf("http://")==0||t.url.indexOf("https://")==0);})
      .forEach(function(t) {
        var o = document.createElement("option"); o.value = String(t.id);
        var h=""; try{h=new URL(t.url).host;}catch(e){h=t.url;}
        o.textContent = "["+t.id+"] "+h+" — "+(t.title||h).slice(0,45);
        sel.appendChild(o);
      });
    if (prev && Array.from(sel.options).some(function(o){return o.value===prev;})) sel.value=prev;
  });
}

// ─── Helpers ──────────────────────────────────────────
function el(tag, cls, text) {
  var e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function txt(s) { return document.createTextNode(s == null ? "" : String(s)); }

function parseURL(url) {
  try { var u=new URL(url); return {host:u.host, path:u.pathname+u.search}; }
  catch(e) { return {host:"", path:url}; }
}

function statusClass(req) {
  if (req.status==="error") return "status-err";
  if (!req.statusCode)      return "status-pending";
  if (req.statusCode>=500)  return "status-5xx";
  if (req.statusCode>=400)  return "status-4xx";
  if (req.statusCode>=300)  return "status-3xx";
  if (req.statusCode>=200)  return "status-2xx";
  return "status-pending";
}

function methodColor(m) {
  return {GET:"var(--green)",POST:"var(--cyan)",PUT:"var(--amber)",DELETE:"var(--red)",
    PATCH:"var(--purple)",OPTIONS:"var(--text-secondary)",HEAD:"var(--blue)"}[m]||"var(--text-secondary)";
}

function validMethod(m) {
  var u = String(m||"").toUpperCase();
  return ALLOWED_METHODS.indexOf(u)>=0 ? u : "GET";
}

function fmtDuration(ms) {
  if (!ms) return "—";
  return ms < 1000 ? ms+"ms" : (ms/1000).toFixed(2)+"s";
}

function fmtSize(b) {
  if (!b) return "0 B";
  if (b<1024) return b+" B";
  if (b<1048576) return (b/1024).toFixed(1)+" KB";
  return (b/1048576).toFixed(2)+" MB";
}

function buildCurl(req) {
  var cmd = "curl -X " + req.method + " '" + req.url.replace(/'/g,"'\\''") + "'";
  Object.keys(req.requestHeaders||{}).forEach(function(k) {
    if (!Object.prototype.hasOwnProperty.call(req.requestHeaders,k)) return;
    cmd += " \\\n  -H '" + (k+": "+req.requestHeaders[k]).replace(/'/g,"'\\''") + "'";
  });
  if (req.requestBody) cmd += " \\\n  -d '" + req.requestBody.replace(/'/g,"'\\''") + "'";
  return cmd;
}

function buildRaw(req) {
  var p = parseURL(req.url);
  var r = req.method + " " + (p.path||"/") + " HTTP/1.1\n" + "Host: " + p.host + "\n";
  Object.keys(req.requestHeaders||{}).forEach(function(k) {
    if (k.toLowerCase()!=="host") r += k+": "+req.requestHeaders[k]+"\n";
  });
  if (req.requestBody) r += "\n"+req.requestBody;
  return r;
}

function setStatus(msg) {
  var s = document.getElementById("status-msg");
  if (s) s.textContent = msg;
}

// ─── Bookmarks ────────────────────────────────────────

var BOOKMARK_COLORS = [
  { color: "#ff3860", label: "Red"    },
  { color: "#ffb700", label: "Orange" },
  { color: "#00ff9d", label: "Green"  },
  { color: "#00e5ff", label: "Cyan"   },
  { color: "#4d9fff", label: "Blue"   },
  { color: "#b44fff", label: "Purple" },
  { color: "#ff9f43", label: "Yellow" },
  { color: "#ff6b9d", label: "Pink"   }
];

var _bmMenu = null; // active context menu DOM node
var _bmMenuReqId = null;

function showBookmarkMenu(reqId, x, y) {
  closeBookmarkMenu();
  _bmMenuReqId = reqId;

  var menu = document.createElement("div");
  menu.id = "bookmark-menu";
  menu.style.cssText = [
    "position:fixed",
    "z-index:9999",
    "left:" + Math.min(x, window.innerWidth - 220) + "px",
    "top:"  + Math.min(y, window.innerHeight - 280) + "px",
    "background:var(--bg-elevated)",
    "border:1px solid var(--border)",
    "border-radius:4px",
    "box-shadow:0 8px 32px rgba(0,0,0,0.5)",
    "padding:8px",
    "min-width:200px",
    "font-family:var(--font-ui)"
  ].join(";");

  // Header
  var hdr = document.createElement("div");
  hdr.style.cssText = "font-size:10px;font-weight:700;letter-spacing:2px;color:var(--text-dim);padding:4px 6px 8px;border-bottom:1px solid var(--border);margin-bottom:8px;";
  hdr.textContent = "HIGHLIGHT ROW";
  menu.appendChild(hdr);

  // Color swatches grid
  var grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:4px;margin-bottom:8px;";

  var current = bookmarkMap[reqId];

  BOOKMARK_COLORS.forEach(function(bc) {
    var swatch = document.createElement("button");
    swatch.title = bc.label;
    var isActive = current && current.color === bc.color;
    swatch.style.cssText = [
      "width:36px", "height:36px",
      "background:" + bc.color,
      "border:" + (isActive ? "3px solid white" : "2px solid transparent"),
      "border-radius:4px",
      "cursor:pointer",
      "transition:transform 0.1s,box-shadow 0.1s",
      "box-shadow:" + (isActive ? "0 0 10px " + bc.color : "none")
    ].join(";");
    swatch.addEventListener("mouseenter", function() {
      swatch.style.transform = "scale(1.12)";
      swatch.style.boxShadow = "0 0 10px " + bc.color;
    });
    swatch.addEventListener("mouseleave", function() {
      swatch.style.transform = isActive ? "scale(1.0)" : "scale(1.0)";
      swatch.style.boxShadow = isActive ? "0 0 10px " + bc.color : "none";
    });
    swatch.addEventListener("click", function() {
      setBookmark(reqId, bc.color, current ? current.label : "");
      closeBookmarkMenu();
    });
    grid.appendChild(swatch);
  });
  menu.appendChild(grid);

  // Label input
  var labelRow = document.createElement("div");
  labelRow.style.cssText = "display:flex;gap:6px;padding:0 4px;margin-bottom:8px;";
  var labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.placeholder = "Add a note…";
  labelInput.value = current ? (current.label || "") : "";
  labelInput.spellcheck = false;
  labelInput.style.cssText = [
    "flex:1", "padding:5px 8px",
    "background:var(--bg-surface)",
    "border:1px solid var(--border)",
    "border-radius:3px",
    "color:var(--text-primary)",
    "font-family:var(--font-mono)",
    "font-size:11px", "outline:none"
  ].join(";");
  labelInput.addEventListener("keydown", function(e) {
    if (e.key === "Enter") {
      var col = current ? current.color : BOOKMARK_COLORS[0].color;
      setBookmark(reqId, col, labelInput.value.trim());
      closeBookmarkMenu();
    }
    e.stopPropagation();
  });
  labelRow.appendChild(labelInput);
  menu.appendChild(labelRow);

  // Divider + clear
  var div = document.createElement("div");
  div.style.cssText = "height:1px;background:var(--border);margin:4px 0;";
  menu.appendChild(div);

  var clearBtn = document.createElement("button");
  clearBtn.textContent = "✕  Remove highlight";
  clearBtn.style.cssText = [
    "width:100%", "padding:7px 10px",
    "background:transparent",
    "border:none", "border-radius:3px",
    "color:var(--text-dim)",
    "font-family:var(--font-ui)",
    "font-size:11px", "font-weight:600",
    "letter-spacing:0.5px",
    "text-align:left", "cursor:pointer",
    "transition:background 0.1s,color 0.1s"
  ].join(";");
  clearBtn.addEventListener("mouseenter", function() {
    clearBtn.style.background = "rgba(255,56,96,0.1)";
    clearBtn.style.color = "var(--red)";
  });
  clearBtn.addEventListener("mouseleave", function() {
    clearBtn.style.background = "transparent";
    clearBtn.style.color = "var(--text-dim)";
  });
  clearBtn.addEventListener("click", function() {
    removeBookmark(reqId);
    closeBookmarkMenu();
  });
  menu.appendChild(clearBtn);

  document.body.appendChild(menu);
  _bmMenu = menu;

  // Focus label input
  setTimeout(function() { labelInput.focus(); }, 50);

  // Close on outside click
  setTimeout(function() {
    document.addEventListener("click", closeBookmarkMenu, { once: true });
    document.addEventListener("keydown", function(e) {
      if (e.key === "Escape") closeBookmarkMenu();
    }, { once: true });
  }, 0);
}

function closeBookmarkMenu() {
  if (_bmMenu) { _bmMenu.remove(); _bmMenu = null; }
}

function setBookmark(reqId, color, label) {
  bookmarkMap[reqId] = { color: color, label: label || "" };
  saveBookmarks();
  refreshRow(reqId);
  setStatus("Highlighted request — " + (label || color));
}

function removeBookmark(reqId) {
  delete bookmarkMap[reqId];
  saveBookmarks();
  refreshRow(reqId);
  setStatus("Highlight removed");
}

function refreshRow(reqId) {
  // Re-render just that row without full list re-render
  var req = allRequests.find(function(r) { return r.id === reqId; });
  if (!req) return;
  var old = document.querySelector('.request-row[data-id="' + CSS.escape(reqId) + '"]');
  if (old) old.replaceWith(makeRow(req));
}

function saveBookmarks() {
  chrome.storage.local.set({ phantomBookmarks: bookmarkMap });
}

function loadBookmarks() {
  chrome.storage.local.get("phantomBookmarks", function(data) {
    if (data.phantomBookmarks) {
      bookmarkMap = data.phantomBookmarks;
    }
  });
}

// ─── Init ─────────────────────────────────────────────
if (IS_STANDALONE) initStandalone();
connectBackground();
setStatus("PhantomProxy ready");
createSession(null);

// Load bookmarks from storage on startup
loadBookmarks();

// Bookmark filter button
var _bmFilterBtn = document.getElementById("btn-filter-bookmarked");
if (_bmFilterBtn) {
  _bmFilterBtn.addEventListener("click", function() {
    bookmarkFilterOn = !bookmarkFilterOn;
    _bmFilterBtn.classList.toggle("active", bookmarkFilterOn);
    renderList();
    setStatus(bookmarkFilterOn ? "Showing highlighted requests only" : "Showing all requests");
  });
}

// ─── Features v2.2 ────────────────────────────────────
if (window.PhantomFeatures) {
  PhantomFeatures.init(
    function() { return allRequests; },          // getRequests
    function(imported) {                          // addRequests
      imported.forEach(function(r) { allRequests.push(r); });
    },
    renderList,
    setStatus
  );
}

// Advanced tools (sitemap, search, diff, intruder, …)
if (window.PhantomAdvanced) {
  PhantomAdvanced.init({
    getRequests: function() { return allRequests; },
    setRequests: function(arr) {
      allRequests = Array.isArray(arr) ? arr : [];
      selectedRequestId = null;
      renderList();
      showDetailEmpty();
    },
    getBookmarks: function() { return bookmarkMap; },
    setBookmarks: function(map) {
      if (map && typeof map === "object") {
        bookmarkMap = map;
        try { chrome.storage.local.set({ phantomBookmarks: bookmarkMap }); } catch(e) {}
      }
    },
    getScope: function() {
      return window.PhantomFeatures ? PhantomFeatures.scopeState : null;
    },
    setStatus: setStatus,
    switchTab: switchTab,
    createSession: createSession,
    sendBg: sendBg,
    selectRequest: selectReq,
    renderList: renderList,
    getActiveSession: function() {
      return repeaterSessions.find(function(x) { return x.id === activeSessionId; }) || null;
    },
    getLastResponse: function() {
      var s = repeaterSessions.find(function(x) { return x.id === activeSessionId; });
      var resp = s && s.response ? s.response : null;
      return {
        body: lastRespBody || (resp && resp.body) || "",
        headers: (resp && resp.responseHeaders) || {},
        status: resp && resp.statusCode || 0,
        method: s && s.method,
        url: s && s.url
      };
    }
  });
}

// Send to Intruder from history detail
var _btnFuzz = document.getElementById("btn-send-fuzzer");
if (_btnFuzz) {
  _btnFuzz.addEventListener("click", function() {
    var req = allRequests.find(function(r) { return r.id === selectedRequestId; });
    if (!req) return;
    switchTab("tools");
    var nav = document.querySelector('.tools-nav-btn[data-tools="intruder"]');
    if (nav) nav.click();
    if (window.PhantomAdvanced && PhantomAdvanced.loadIntruderFromRequest) {
      PhantomAdvanced.loadIntruderFromRequest(req);
    } else {
      var urlEl = document.getElementById("fuzz-url");
      var methodEl = document.getElementById("fuzz-method");
      var tplEl = document.getElementById("fuzz-template");
      var hdrEl = document.getElementById("fuzz-headers");
      if (urlEl) urlEl.value = req.url || "";
      if (methodEl) methodEl.value = req.method || "GET";
      if (tplEl) tplEl.value = req.requestBody || "";
      if (hdrEl && req.requestHeaders) {
        hdrEl.value = Object.keys(req.requestHeaders).map(function(k) {
          return k + ": " + req.requestHeaders[k];
        }).join("\n");
      }
      setStatus("Loaded into Intruder — mark payload with §…§");
    }
  });
}

// History compare A/B
function wireCompareBtn(id, side) {
  var btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener("click", function() {
    var req = allRequests.find(function(r) { return r.id === selectedRequestId; });
    if (!req) { setStatus("Select a request first"); return; }
    if (window.PhantomAdvanced && PhantomAdvanced.setCompareSide) {
      PhantomAdvanced.setCompareSide(side, req);
      switchTab("tools");
      var nav = document.querySelector('.tools-nav-btn[data-tools="compare"]');
      if (nav) nav.click();
    }
  });
}
wireCompareBtn("btn-cmp-a", "a");
wireCompareBtn("btn-cmp-b", "b");

// Scope toggle button text is managed by PhantomFeatures.updateScopeUI
var _scopeToggleBtn = document.getElementById("scope-toggle");
if (_scopeToggleBtn && window.PhantomFeatures && PhantomFeatures.scopeState) {
  _scopeToggleBtn.textContent = PhantomFeatures.scopeState.enabled ? "SCOPE ON" : "SCOPE OFF";
}

// ─── Proxy Intercept UI ───────────────────────────────
var interceptActive = false;
var interceptQueue = []; // paused entries from SW
var interceptSelectedId = null;

function getInterceptTargetTabId() {
  if (IS_STANDALONE) {
    var sel = document.getElementById("tab-target-select");
    if (!sel || sel.value === "all") return null;
    var tid = parseInt(sel.value, 10);
    return isFinite(tid) ? tid : null;
  }
  if (chrome.devtools && chrome.devtools.inspectedWindow) {
    return chrome.devtools.inspectedWindow.tabId;
  }
  return null;
}

function setInterceptButtons(active) {
  interceptActive = !!active;
  var top = document.getElementById("btn-intercept");
  var mid = document.getElementById("btn-intercept-toggle");
  var st = document.getElementById("intercept-status");
  if (top) {
    top.classList.toggle("active", interceptActive);
    top.textContent = interceptActive ? "◎ INTERCEPT ON" : "◎ INTERCEPT OFF";
  }
  if (mid) {
    mid.classList.toggle("active", interceptActive);
    mid.textContent = interceptActive ? "INTERCEPT ON" : "INTERCEPT OFF";
  }
  if (st) {
    st.textContent = interceptActive
      ? ("Listening · queue " + interceptQueue.length)
      : "Idle";
    st.style.color = interceptActive ? "var(--green)" : "var(--text-dim)";
  }
}

function updateInterceptQueueCount(n) {
  var el = document.getElementById("intercept-queue-count");
  if (el) el.textContent = String(n != null ? n : interceptQueue.length);
}

function renderInterceptQueue() {
  var list = document.getElementById("intercept-queue");
  if (!list) return;
  list.innerHTML = "";
  if (!interceptQueue.length) {
    var empty = document.createElement("div");
    empty.className = "adv-empty";
    empty.textContent = interceptActive
      ? "Waiting for requests… browse the target tab"
      : "Turn INTERCEPT ON to hold live requests";
    list.appendChild(empty);
    updateInterceptQueueCount(0);
    return;
  }
  interceptQueue.forEach(function(entry) {
    var row = document.createElement("div");
    row.className = "intercept-queue-row" +
      (entry.networkId === interceptSelectedId ? " selected" : "");
    var m = document.createElement("span");
    m.className = "intercept-q-method";
    m.textContent = entry.method || "";
    var u = document.createElement("span");
    u.className = "intercept-q-url";
    u.textContent = entry.url || "";
    u.title = entry.url || "";
    var t = document.createElement("span");
    t.className = "intercept-q-type";
    t.textContent = entry.resourceType || "";
    row.append(m, u, t);
    row.addEventListener("click", function() {
      selectInterceptEntry(entry.networkId);
    });
    list.appendChild(row);
  });
  updateInterceptQueueCount(interceptQueue.length);
}

function selectInterceptEntry(networkId) {
  interceptSelectedId = networkId;
  var entry = null;
  for (var i = 0; i < interceptQueue.length; i++) {
    if (interceptQueue[i].networkId === networkId) { entry = interceptQueue[i]; break; }
  }
  renderInterceptQueue();
  if (!entry) return;
  var methodEl = document.getElementById("intercept-method");
  var urlEl = document.getElementById("intercept-url");
  var hdrEl = document.getElementById("intercept-headers");
  var bodyEl = document.getElementById("intercept-body");
  if (methodEl) methodEl.value = entry.method || "GET";
  if (urlEl) urlEl.value = entry.url || "";
  if (hdrEl) {
    var h = entry.headers || {};
    hdrEl.value = Object.keys(h).map(function(k) { return k + ": " + h[k]; }).join("\n");
  }
  if (bodyEl) bodyEl.value = entry.body || "";
}

function clearInterceptEditor() {
  interceptSelectedId = null;
  var urlEl = document.getElementById("intercept-url");
  var hdrEl = document.getElementById("intercept-headers");
  var bodyEl = document.getElementById("intercept-body");
  if (urlEl) urlEl.value = "";
  if (hdrEl) hdrEl.value = "";
  if (bodyEl) bodyEl.value = "";
}

function onInterceptState(msg) {
  if (msg.error) setStatus("Intercept: " + msg.error);
  setInterceptButtons(!!msg.active);
  var help = document.getElementById("intercept-help");
  var modeEl = document.getElementById("intercept-mode-badge");
  if (!msg.active) {
    interceptQueue = [];
    clearInterceptEditor();
    renderInterceptQueue();
    if (modeEl) modeEl.textContent = "";
  } else {
    if (typeof msg.queueSize === "number") updateInterceptQueueCount(msg.queueSize);
    if (modeEl) {
      modeEl.textContent = msg.mode === "page" ? "MODE: PAGE HOOK (fetch/XHR)" : "MODE: DEBUGGER (full HTTP)";
      modeEl.style.color = msg.mode === "page" ? "var(--amber)" : "var(--green)";
    }
    setStatus(msg.message || ("Intercept ON · " + (msg.mode || "") + " · tab " + msg.tabId));
  }
  if (help && msg.active && msg.mode === "page") {
    help.textContent = "Page-hook mode: intercepts fetch() and XHR from the page (works with DevTools open). Reload the target tab once after enabling for full coverage. Keyboard: F = Forward, D = Drop.";
  } else if (help && msg.active) {
    help.textContent = "Debugger mode: holds all HTTP (banner may show). Forward/Drop from the queue. Keyboard: F = Forward, D = Drop. Optional response stage holds responses too.";
  }
}

function onInterceptPaused(msg) {
  if (!msg || !msg.request) return;
  // de-dupe by networkId
  interceptQueue = interceptQueue.filter(function(e) {
    return e.networkId !== msg.request.networkId;
  });
  interceptQueue.push(msg.request);
  if (interceptQueue.length > 40) interceptQueue.shift();
  renderInterceptQueue();
  if (!interceptSelectedId) selectInterceptEntry(msg.request.networkId);
  setStatus("Intercepted " + (msg.request.method || "") + " " + (msg.request.url || "").slice(0, 60));
  // Optional: auto-open intercept tab
  var badge = document.querySelector('[data-tab="intercept"]');
  if (badge) badge.classList.add("has-queue");
}

function onInterceptReleased(msg) {
  if (!msg || !msg.networkId) return;
  interceptQueue = interceptQueue.filter(function(e) { return e.networkId !== msg.networkId; });
  if (interceptSelectedId === msg.networkId) {
    clearInterceptEditor();
    if (interceptQueue.length) selectInterceptEntry(interceptQueue[0].networkId);
  }
  renderInterceptQueue();
  if (typeof msg.queueSize === "number") updateInterceptQueueCount(msg.queueSize);
  var badge = document.querySelector('[data-tab="intercept"]');
  if (badge && !interceptQueue.length) badge.classList.remove("has-queue");
}

function toggleIntercept() {
  if (interceptActive) {
    sendBg({ type: "INTERCEPT_STOP" });
    setStatus("Intercept stopping…");
    return;
  }
  var tabId = getInterceptTargetTabId();
  if (tabId == null) {
    setStatus(IS_STANDALONE
      ? "⚠ Select a specific TARGET TAB (not All Tabs) before enabling intercept"
      : "⚠ No inspected tab available");
    switchTab("intercept");
    return;
  }
  var scopeOnly = !!(document.getElementById("intercept-scope-only") || {}).checked;
  var stageResponse = !!(document.getElementById("intercept-stage-response") || {}).checked;
  // DevTools already holds the debugger → prefer page-hook (fetch/XHR)
  var preferPage = !IS_STANDALONE || !!(document.getElementById("intercept-prefer-page") || {}).checked;
  var domains = [];
  if (window.PhantomFeatures && PhantomFeatures.scopeState && Array.isArray(PhantomFeatures.scopeState.domains)) {
    domains = PhantomFeatures.scopeState.domains.slice();
  }
  setStatus("Starting intercept on tab " + tabId + "…");
  sendBg({
    type: "INTERCEPT_START",
    tabId: tabId,
    scopeOnly: scopeOnly,
    stageResponse: stageResponse,
    preferPage: preferPage,
    domains: domains
  });
  switchTab("intercept");
}

function collectInterceptEdits() {
  return {
    networkId: interceptSelectedId,
    method: (document.getElementById("intercept-method") || {}).value,
    url: (document.getElementById("intercept-url") || {}).value,
    headersText: (document.getElementById("intercept-headers") || {}).value,
    body: (document.getElementById("intercept-body") || {}).value
  };
}

var _btnIxTop = document.getElementById("btn-intercept");
var _btnIxMid = document.getElementById("btn-intercept-toggle");
if (_btnIxTop) _btnIxTop.addEventListener("click", toggleIntercept);
if (_btnIxMid) _btnIxMid.addEventListener("click", toggleIntercept);

var _btnIxFwd = document.getElementById("btn-intercept-forward");
if (_btnIxFwd) {
  _btnIxFwd.addEventListener("click", function() {
    if (!interceptSelectedId) { setStatus("Select a queued request"); return; }
    var edits = collectInterceptEdits();
    sendBg({
      type: "INTERCEPT_FORWARD",
      networkId: edits.networkId,
      method: edits.method,
      url: edits.url,
      headersText: edits.headersText,
      body: edits.body
    });
  });
}
var _btnIxDrop = document.getElementById("btn-intercept-drop");
if (_btnIxDrop) {
  _btnIxDrop.addEventListener("click", function() {
    if (!interceptSelectedId) { setStatus("Select a queued request"); return; }
    sendBg({ type: "INTERCEPT_DROP", networkId: interceptSelectedId });
  });
}
var _btnIxFwdAll = document.getElementById("btn-intercept-forward-all");
if (_btnIxFwdAll) {
  _btnIxFwdAll.addEventListener("click", function() {
    sendBg({ type: "INTERCEPT_FORWARD_ALL" });
  });
}
var _btnIxDropAll = document.getElementById("btn-intercept-drop-all");
if (_btnIxDropAll) {
  _btnIxDropAll.addEventListener("click", function() {
    sendBg({ type: "INTERCEPT_DROP_ALL" });
  });
}

// cURL import event → create repeater session
document.addEventListener("phantom:curl-import", function(e) {
  var parsed = e.detail;
  if (!parsed || !parsed.url) return;
  var fakeReq = {
    method:         parsed.method || "GET",
    url:            parsed.url,
    requestHeaders: parsed.headers || {},
    requestBody:    parsed.body || null,
    cookies:        extractCookiesFromReq({ requestHeaders: parsed.headers || {} })
  };
  createSession(fakeReq);
  switchTab("repeater");
});

// Keyboard shortcuts
document.addEventListener("keydown", function(e) {
  // Don't steal keys while typing in inputs
  var tag = (e.target && e.target.tagName) || "";
  var typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target && e.target.isContentEditable);

  // Ctrl+Enter in repeater URL field = send
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    var active = document.activeElement;
    if (active && (active.id === "rep-url" || active.id === "rep-body" || active.id === "rep-raw" ||
        active.id === "intercept-url" || active.id === "intercept-body" || active.id === "intercept-headers")) {
      e.preventDefault();
      if (active.id.indexOf("intercept") === 0) {
        if (_btnIxFwd) _btnIxFwd.click();
      } else {
        doSend();
      }
    }
  }
  // Intercept: F = forward, D = drop (when not typing)
  if (!typing && interceptActive && interceptSelectedId) {
    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      if (_btnIxFwd) _btnIxFwd.click();
    } else if (e.key === "d" || e.key === "D") {
      e.preventDefault();
      if (_btnIxDrop) _btnIxDrop.click();
    }
  }
  // Ctrl+L = clear
  if ((e.ctrlKey || e.metaKey) && e.key === "l") {
    e.preventDefault();
    sendBg({ type: "CLEAR_REQUESTS" });
  }
  // Ctrl+F = focus filter
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    var fi = document.getElementById("filter-url");
    if (fi) { e.preventDefault(); fi.focus(); fi.select(); }
  }
});

// Repeater → Intruder
var _btnRepFuzz = document.getElementById("btn-rep-to-fuzz");
if (_btnRepFuzz) {
  _btnRepFuzz.addEventListener("click", function() {
    saveSession();
    var s = repeaterSessions.find(function(x) { return x.id === activeSessionId; });
    if (!s || !s.url) {
      setStatus("Set a URL in Repeater first");
      return;
    }
    var fake = {
      method: s.method,
      url: s.url,
      requestHeaders: s.headers || {},
      requestBody: s.body || null,
      cookies: s.cookies || []
    };
    switchTab("tools");
    var nav = document.querySelector('.tools-nav-btn[data-tools="intruder"]');
    if (nav) nav.click();
    if (window.PhantomAdvanced && PhantomAdvanced.loadIntruderFromRequest) {
      PhantomAdvanced.loadIntruderFromRequest(fake);
    }
    setStatus("Repeater request loaded into Intruder — mark § positions");
  });
}
