// PhantomProxy — Background Service Worker v2.3.0
// Capture · Repeater · Cookies · Intercept (debugger + page hook) · SSRF guards
// Classic SW (no ES module) for full MV3 + Edge webRequest compatibility
"use strict";

var MAX_REQUESTS       = 500;
var MAX_BODY_BYTES     = 64 * 1024;
var MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
var MAX_CONCURRENT_OUT = 2;   // concurrent repeater/fuzzer fetches (keep low for DNR cookie safety)
var MAX_OUTBOUND_QUEUE = 50;
var ALLOWED_SCHEMES    = ["http:", "https:"];
var ALLOWED_METHODS    = ["GET","POST","PUT","PATCH","DELETE","OPTIONS","HEAD"];

var BLOCKED_HOSTS = [
  /^localhost$/i, /^127\./, /^0\.0\.0\.0$/, /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./,
  /^::1$/, /^fc00:/i, /^fd[0-9a-f]{2}:/i, /^fe80:/i,
  /\.local$/i, /\.localhost$/i, /\.internal$/i,
  /^metadata\.google\.internal$/i
];

var requestStore  = [];
var requestMap    = {};
var devtoolsPorts = {};
var portCounter   = 0;
var outboundInflight = 0;
var outboundQueue    = [];
var dnrRuleBusy      = false;

// ─── Keep service worker alive while ports connected ──
var keepAliveInterval = null;

function startKeepalive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(function() {
    // ping self to prevent SW termination
    chrome.runtime.getPlatformInfo(function() {});
  }, 25000);
}

function stopKeepalive() {
  if (Object.keys(devtoolsPorts).length === 0 && keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// ─── Port Connections ─────────────────────────────────
chrome.runtime.onConnect.addListener(function(port) {
  var isDevtools   = port.name.indexOf("phantom-devtools-") === 0;
  var isStandalone = port.name === "phantom-standalone";

  if (!isDevtools && !isStandalone) {
    port.disconnect();
    return;
  }

  var key;

  if (isDevtools) {
    var rawId = port.name.replace("phantom-devtools-", "");
    var tabId = parseInt(rawId, 10);
    if (!isFinite(tabId)) { port.disconnect(); return; }
    key = "devtools_" + tabId;
  } else {
    key = "standalone_" + (++portCounter);
  }

  devtoolsPorts[key] = port;
  startKeepalive();

  port.onMessage.addListener(function(msg) {
    handlePanelMessage(msg, port);
  });

  port.onDisconnect.addListener(function() {
    delete devtoolsPorts[key];
    stopKeepalive();
  });

  // Send existing requests immediately
  port.postMessage({ type: "INIT_REQUESTS", requests: requestStore });
});

function broadcastToDevtools(message) {
  Object.keys(devtoolsPorts).forEach(function(key) {
    try { devtoolsPorts[key].postMessage(message); } catch(e) {}
  });
}

// ─── Message Handler ──────────────────────────────────
function handlePanelMessage(msg, port) {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "GET_REQUESTS") {
    port.postMessage({ type: "INIT_REQUESTS", requests: requestStore });
    return;
  }

  if (msg.type === "CLEAR_REQUESTS") {
    requestStore = [];
    broadcastToDevtools({ type: "REQUESTS_CLEARED" });
    return;
  }

  if (msg.type === "SEND_REPEATER") {
    var req = msg.request;
    if (!req || typeof req !== "object") return;
    // Cap body / header sizes from untrusted panel messages
    if (typeof req.url === "string" && req.url.length > 8192) {
      port.postMessage({
        type: "REPEATER_RESPONSE", id: req.id || null,
        result: { success: false, error: "Blocked: URL too long" }
      });
      return;
    }
    if (typeof req.requestBody === "string" && req.requestBody.length > MAX_BODY_BYTES) {
      req.requestBody = req.requestBody.slice(0, MAX_BODY_BYTES);
    }
    var err = validateRepeaterRequest(req);
    if (err) {
      port.postMessage({
        type: "REPEATER_RESPONSE",
        id: req.id || null,
        result: { success: false, error: "Blocked: " + err }
      });
      return;
    }
    enqueueOutbound(req, port);
    return;
  }

  if (msg.type === "GET_COOKIES") {
    var cookieUrl = typeof msg.url === "string" ? msg.url : "";
    var curlErr = cookieUrl ? validateURL(cookieUrl) : "Missing URL";
    if (curlErr) {
      port.postMessage({
        type: "COOKIES_RESULT",
        url: cookieUrl,
        cookies: [],
        requestId: msg.requestId || null,
        error: curlErr
      });
      return;
    }
    getCookiesForUrl(cookieUrl, function(cookies) {
      port.postMessage({
        type: "COOKIES_RESULT",
        url: cookieUrl,
        cookies: cookies,
        requestId: typeof msg.requestId === "string" ? msg.requestId.slice(0, 64) : null
      });
    });
    return;
  }

  if (msg.type === "DELETE_REQUEST") {
    if (typeof msg.id === "string") {
      requestStore = requestStore.filter(function(r) { return r.id !== msg.id; });
      broadcastToDevtools({ type: "REQUEST_DELETED", id: msg.id });
    }
    return;
  }

  // ── Intercept (debugger Fetch) ──
  if (msg.type === "INTERCEPT_START") {
    startIntercept(msg, port);
    return;
  }
  if (msg.type === "INTERCEPT_STOP") {
    stopIntercept(function(err) {
      port.postMessage({ type: "INTERCEPT_STATE", active: false, error: err || null });
    });
    return;
  }
  if (msg.type === "INTERCEPT_FORWARD") {
    forwardIntercepted(msg, port);
    return;
  }
  if (msg.type === "INTERCEPT_DROP") {
    dropIntercepted(msg, port);
    return;
  }
  if (msg.type === "INTERCEPT_FORWARD_ALL") {
    forwardAllIntercepted(port);
    return;
  }
  if (msg.type === "INTERCEPT_DROP_ALL") {
    dropAllIntercepted(port);
    return;
  }
  if (msg.type === "INTERCEPT_STATUS") {
    port.postMessage({
      type: "INTERCEPT_STATE",
      active: interceptState.active,
      tabId: interceptState.tabId,
      queueSize: Object.keys(interceptState.paused).length,
      scopeOnly: interceptState.scopeOnly,
      domains: interceptState.domains
    });
    return;
  }
}

// ─── webRequest Capture ───────────────────────────────
chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    if (shouldSkip(details.url)) return;
    var key = details.requestId + "_" + details.tabId;
    requestMap[key] = {
      id:              details.requestId + "_" + Date.now(),
      requestId:       details.requestId,
      url:             details.url,
      method:          sanitizeMethod(details.method),
      timestamp:       Date.now(),
      tabId:           details.tabId,
      type:            sanitizeType(details.type),
      status:          "pending",
      requestBody:     extractBody(details.requestBody),
      requestHeaders:  {},
      responseHeaders: {},
      statusCode:      null,
      duration:        null,
      _start:          Date.now()
    };
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

chrome.webRequest.onSendHeaders.addListener(
  function(details) {
    var entry = requestMap[details.requestId + "_" + details.tabId];
    if (!entry) return;
    var h = {};
    // Merge multi-value headers (esp. Cookie / Set-Cookie style) carefully
    details.requestHeaders.forEach(function(hdr) {
      var n = sanitizeToken(hdr.name);
      if (!n) return;
      var v = sanitizeValue(hdr.value);
      // Cookie can appear once; if duplicated, join with "; "
      if (h[n] !== undefined && n.toLowerCase() === "cookie") {
        h[n] = h[n] + "; " + v;
      } else {
        h[n] = v;
      }
    });
    entry.requestHeaders = h;
  },
  { urls: ["<all_urls>"] },
  // extraHeaders is required on Chromium to receive Cookie / Referer / etc.
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  function(details) {
    var entry = requestMap[details.requestId + "_" + details.tabId];
    if (!entry) return;
    var h = {};
    details.responseHeaders.forEach(function(hdr) {
      var n = sanitizeToken(hdr.name);
      if (!n) return;
      var v = sanitizeValue(hdr.value);
      // Set-Cookie often appears multiple times — keep all values
      if (h[n] !== undefined && n.toLowerCase() === "set-cookie") {
        h[n] = h[n] + "\n" + v;
      } else {
        h[n] = v;
      }
    });
    entry.responseHeaders = h;
    entry.statusCode = details.statusCode;
  },
  { urls: ["<all_urls>"] },
  // extraHeaders required to observe Set-Cookie
  ["responseHeaders", "extraHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  function(details) {
    var key   = details.requestId + "_" + details.tabId;
    var entry = requestMap[key];
    if (!entry) return;
    entry.status     = "complete";
    entry.statusCode = details.statusCode;
    entry.duration   = Date.now() - entry._start;
    delete entry._start;
    finalizeRequest(entry);
    delete requestMap[key];
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  function(details) {
    var key   = details.requestId + "_" + details.tabId;
    var entry = requestMap[key];
    if (!entry) return;
    entry.status   = "error";
    entry.error    = sanitizeValue(details.error || "Unknown error");
    entry.duration = Date.now() - (entry._start || Date.now());
    delete entry._start;
    finalizeRequest(entry);
    delete requestMap[key];
  },
  { urls: ["<all_urls>"] }
);

function finalizeRequest(entry) {
  if (requestStore.length >= MAX_REQUESTS) requestStore.shift();
  requestStore.push(entry);
  broadcastToDevtools({ type: "NEW_REQUEST", request: entry });
}

// ─── Outbound queue (rate limit fuzzer / parallel abuse) ─
function enqueueOutbound(req, port) {
  if (outboundQueue.length >= MAX_OUTBOUND_QUEUE) {
    port.postMessage({
      type: "REPEATER_RESPONSE",
      id: req.id || null,
      result: { success: false, error: "Blocked: outbound queue full (slow down)" }
    });
    return;
  }
  outboundQueue.push({ req: req, port: port });
  pumpOutbound();
}

function pumpOutbound() {
  while (outboundInflight < MAX_CONCURRENT_OUT && outboundQueue.length) {
    var job = outboundQueue.shift();
    outboundInflight++;
    sendRepeaterRequest(job.req).then(function(result) {
      outboundInflight--;
      try {
        job.port.postMessage({ type: "REPEATER_RESPONSE", id: job.req.id, result: result });
      } catch (e) {}
      pumpOutbound();
    }).catch(function(e) {
      outboundInflight--;
      try {
        job.port.postMessage({
          type: "REPEATER_RESPONSE",
          id: job.req.id,
          result: { success: false, error: String(e && e.message || e) }
        });
      } catch (err) {}
      pumpOutbound();
    });
  }
}

// ─── URL Validation ───────────────────────────────────
function isBlockedHostname(host) {
  if (!host || typeof host !== "string") return true;
  host = host.toLowerCase().replace(/^\[|\]$/g, "");
  // Decimal IP → dotted form
  if (/^\d+$/.test(host)) {
    var n = parseInt(host, 10);
    if (n <= 0xffffffff) {
      host = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
    }
  }
  for (var i = 0; i < BLOCKED_HOSTS.length; i++) {
    if (BLOCKED_HOSTS[i].test(host)) return true;
  }
  var m = host.match(/^:?ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (m) {
    for (var j = 0; j < BLOCKED_HOSTS.length; j++) {
      if (BLOCKED_HOSTS[j].test(m[1])) return true;
    }
  }
  return false;
}

function validateURL(url) {
  if (typeof url !== "string" || !url) return "Invalid URL";
  if (url.length > 8192) return "URL too long";
  var parsed;
  try { parsed = new URL(url); } catch(e) { return "Invalid URL"; }
  if (ALLOWED_SCHEMES.indexOf(parsed.protocol) === -1) {
    return "Scheme '" + parsed.protocol + "' not allowed";
  }
  var host = parsed.hostname.toLowerCase();
  if (!host) return "Missing hostname";
  if (host.indexOf("%") >= 0) return "Encoded hostnames blocked";
  if (isBlockedHostname(host)) return "Hostname '" + host + "' is blocked (private/metadata)";
  return null;
}

function validateRepeaterRequest(req) {
  if (!req.method || ALLOWED_METHODS.indexOf(req.method.toUpperCase()) === -1) {
    return "Method '" + req.method + "' not allowed";
  }
  return validateURL(req.url);
}

// ─── Cookie helpers (Repeater) ────────────────────────
// fetch() treats Cookie as a forbidden header. We inject it via a
// temporary declarativeNetRequest session rule so edited cookies
// actually leave the browser. Falls back to chrome.cookies when DNR
// is unavailable.

var REPEATER_COOKIE_RULE_ID = 900001;

function buildCookieHeader(cookies) {
  if (!cookies) return "";
  if (typeof cookies === "string") return sanitizeValue(cookies);
  if (!Array.isArray(cookies)) return "";
  return cookies
    .filter(function(c) { return c && c.name; })
    .map(function(c) {
      return sanitizeToken(c.name) + "=" + sanitizeValue(String(c.value == null ? "" : c.value));
    })
    .filter(function(pair) { return pair.indexOf("=") > 0; })
    .join("; ");
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function injectCookieHeader(url, cookieHeader) {
  if (!cookieHeader || !chrome.declarativeNetRequest) return false;
  var host;
  try { host = new URL(url).hostname; } catch (e) { return false; }
  if (!host || isBlockedHostname(host)) return false;
  // Cap cookie header size (browser limits ~4–8KB typically)
  if (cookieHeader.length > 8192) cookieHeader = cookieHeader.slice(0, 8192);

  // Wait briefly for concurrent fuzzer requests to release the DNR rule lock
  var waits = 0;
  while (dnrRuleBusy && waits < 40) {
    await sleep(25);
    waits++;
  }
  if (dnrRuleBusy) return false;

  dnrRuleBusy = true;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [REPEATER_COOKIE_RULE_ID],
      addRules: [{
        id: REPEATER_COOKIE_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{
            header: "Cookie",
            operation: "set",
            value: cookieHeader
          }]
        },
        condition: {
          requestDomains: [host],
          resourceTypes: ["xmlhttprequest", "other"]
        }
      }]
    });
    return true;
  } catch (e) {
    dnrRuleBusy = false;
    return false;
  }
}

async function clearCookieRule() {
  if (!chrome.declarativeNetRequest) {
    dnrRuleBusy = false;
    return;
  }
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [REPEATER_COOKIE_RULE_ID]
    });
  } catch (e) {}
  dnrRuleBusy = false;
}

/**
 * Load browser cookies for a URL (used by panel "Load browser cookies").
 */
function getCookiesForUrl(url, callback) {
  if (!chrome.cookies || !chrome.cookies.getAll) {
    callback([]);
    return;
  }
  try {
    chrome.cookies.getAll({ url: url }, function(list) {
      if (chrome.runtime.lastError || !list) {
        callback([]);
        return;
      }
      callback(list.map(function(c) {
        return { name: c.name, value: c.value, domain: c.domain, path: c.path };
      }));
    });
  } catch (e) {
    callback([]);
  }
}

// ─── Repeater Fetch ───────────────────────────────────
async function sendRepeaterRequest(req) {
  var start = Date.now();
  var usedDnr = false;
  try {
    var method      = req.method.toUpperCase();
    var safeHeaders = {};
    var raw         = req.requestHeaders || {};
    var cookieFromHeaders = "";

    Object.keys(raw).forEach(function(k) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) return;
      var name  = sanitizeToken(k);
      var value = sanitizeValue(raw[k]);
      if (!name) return;
      var lower = name.toLowerCase();
      if (["host","content-length","transfer-encoding","connection"].indexOf(lower) >= 0) return;
      // Cookie cannot be set via fetch() headers — stash and inject via DNR
      if (lower === "cookie") {
        cookieFromHeaders = value;
        return;
      }
      safeHeaders[name] = value;
    });

    // Prefer explicit cookies array from the COOKIES editor tab
    var cookieHeader = buildCookieHeader(req.cookies);
    if (!cookieHeader) cookieHeader = cookieFromHeaders;

    if (cookieHeader) {
      usedDnr = await injectCookieHeader(req.url, cookieHeader);
      // Also leave Cookie in headers for environments that allow it
      if (!usedDnr) safeHeaders["Cookie"] = cookieHeader;
    }

    var options = {
      method: method,
      headers: safeHeaders,
      redirect: "manual",
      // Include jar cookies when we didn't override; DNR overrides when we did
      credentials: "include"
    };
    if (method !== "GET" && method !== "HEAD" && req.requestBody) {
      options.body = req.requestBody.slice(0, MAX_BODY_BYTES);
    }

    var response = await fetch(req.url, options);
    var duration = Date.now() - start;
    var resHeaders = {};
    response.headers.forEach(function(val, key) {
      resHeaders[sanitizeToken(key)] = sanitizeValue(val);
    });

    var body     = "";
    var ct       = response.headers.get("content-type") || "";
    var isText   = ct.indexOf("text") >= 0 || ct.indexOf("json") >= 0 ||
                   ct.indexOf("xml") >= 0  || ct.indexOf("javascript") >= 0;

    if (isText) {
      var reader    = response.body.getReader();
      var chunks    = [];
      var total     = 0;
      var truncated = false;
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.length;
        if (total > MAX_RESPONSE_BYTES) { truncated = true; reader.cancel(); break; }
        chunks.push(chunk.value);
      }
      var dec = new TextDecoder();
      body = chunks.map(function(c) { return dec.decode(c, { stream: true }); }).join("");
      if (truncated) body += "\n\n[... truncated at " + (MAX_RESPONSE_BYTES/1024) + "KB ...]";
    } else {
      body = "[Binary response — not displayed]";
    }

    return {
      success: true, statusCode: response.status, statusText: response.statusText,
      responseHeaders: resHeaders, body: body, duration: duration, size: body.length
    };
  } catch(err) {
    return { success: false, error: err.message, duration: Date.now() - start };
  } finally {
    if (usedDnr) await clearCookieRule();
  }
}

// ─── Sanitization ─────────────────────────────────────
var ALLOWED_TYPES = ["main_frame","sub_frame","stylesheet","script","image","font",
  "object","xmlhttprequest","ping","csp_report","media","websocket","other"];

function sanitizeMethod(m) {
  var u = String(m || "").toUpperCase();
  return ALLOWED_METHODS.indexOf(u) >= 0 ? u : "GET";
}
function sanitizeType(t) {
  return ALLOWED_TYPES.indexOf(t) >= 0 ? t : "other";
}
function sanitizeToken(name) {
  if (typeof name !== "string") return "";
  return name.replace(/[\r\n\0]/g, "").replace(/[^\w!#$%&'*+.^`|~-]/g, "").trim().slice(0, 256);
}
function sanitizeValue(value) {
  if (typeof value !== "string") return String(value == null ? "" : value);
  return value.replace(/[\r\n\0]/g, " ").slice(0, 64 * 1024);
}
function isSafeKey(k) {
  if (typeof k !== "string" || !k) return false;
  var lower = k.toLowerCase();
  return lower !== "__proto__" && lower !== "constructor" && lower !== "prototype";
}
function shouldSkip(url) {
  if (typeof url !== "string") return true;
  return url.startsWith("chrome-extension://") || url.startsWith("chrome://") ||
         url.startsWith("edge://") || url.startsWith("devtools://") ||
         url.startsWith("about:") || url.startsWith("data:") ||
         url.startsWith("blob:") || url.startsWith("file:") ||
         url.startsWith("javascript:") || url.startsWith("view-source:");
}
function extractBody(requestBody) {
  if (!requestBody) return null;
  if (requestBody.raw && requestBody.raw[0] && requestBody.raw[0].bytes) {
    try {
      var bytes = new Uint8Array(requestBody.raw[0].bytes);
      var slice = bytes.slice(0, MAX_BODY_BYTES);
      var text  = new TextDecoder("utf-8", { fatal: false }).decode(slice);
      return bytes.length > MAX_BODY_BYTES ? text + "\n[truncated]" : text;
    } catch(e) { return "[binary body]"; }
  }
  if (requestBody.formData) {
    return Object.keys(requestBody.formData)
      .filter(function(k) {
        return isSafeKey(k) && Object.prototype.hasOwnProperty.call(requestBody.formData, k);
      })
      .map(function(k) {
        var v = requestBody.formData[k];
        // formData values are arrays
        var val = Array.isArray(v) ? v.map(String).join(",") : String(v);
        return encodeURIComponent(k) + "=" + encodeURIComponent(val);
      })
      .join("&").slice(0, MAX_BODY_BYTES);
  }
  return null;
}

// ═══════════════════════════════════════════════════════
// PROXY INTERCEPT
// Mode A: chrome.debugger + Fetch (full HTTP, yellow banner)
// Mode B: page hook fetch/XHR (works with DevTools open)
// ═══════════════════════════════════════════════════════

var MAX_INTERCEPT_QUEUE = 40;

var interceptState = {
  active: false,
  tabId: null,
  mode: null,           // "debugger" | "page"
  stages: { request: true, response: false },
  scopeOnly: false,
  domains: [],
  paused: Object.create(null), // id -> meta
  attaching: false
};

// Reject unexpected one-shot messages that aren't from our ports
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (sender && sender.id && sender.id !== chrome.runtime.id) return;

  if (msg && msg.type === "WAKE") {
    sendResponse({ ok: true });
    return true;
  }

  // Page-hook intercept pause (from content bridge)
  if (msg && msg.type === "PAGE_INTERCEPT_PAUSE") {
    if (!interceptState.active || interceptState.mode !== "page") return;
    if (sender.tab && interceptState.tabId != null && sender.tab.id !== interceptState.tabId) return;

    var url = typeof msg.url === "string" ? msg.url : "";
    if (interceptSkipUrl(url) || !interceptInScope(url)) {
      // Auto-forward out of scope
      pageDecision(msg.id, { action: "forward" });
      return;
    }
    if (Object.keys(interceptState.paused).length >= MAX_INTERCEPT_QUEUE) {
      pageDecision(msg.id, { action: "forward" });
      broadcastToDevtools({
        type: "INTERCEPT_OVERFLOW",
        message: "Intercept queue full — auto-forwarded"
      });
      return;
    }

    var headers = Object.create(null);
    if (msg.headers && typeof msg.headers === "object") {
      Object.keys(msg.headers).forEach(function(k) {
        if (!isSafeKey(k)) return;
        var n = sanitizeToken(k) || k;
        headers[n] = sanitizeValue(String(msg.headers[k]));
      });
    }
    var entry = {
      networkId: String(msg.id || ""),
      tabId: interceptState.tabId,
      url: url.slice(0, 8192),
      method: sanitizeMethod(msg.method || "GET"),
      headers: headers,
      body: typeof msg.body === "string" ? msg.body.slice(0, MAX_BODY_BYTES) : null,
      resourceType: msg.resourceType || "fetch",
      stage: "Request",
      mode: "page",
      timestamp: Date.now()
    };
    if (!entry.networkId) return;
    interceptState.paused[entry.networkId] = entry;
    broadcastToDevtools({
      type: "INTERCEPT_PAUSED",
      request: entry,
      queueSize: Object.keys(interceptState.paused).length
    });
    return;
  }
});

function pageDecision(id, decision) {
  if (interceptState.tabId == null) return;
  var headers = decision.headers;
  // Convert array form to object if needed
  if (Array.isArray(headers)) {
    var o = Object.create(null);
    headers.forEach(function(h) {
      if (h && h.name) o[h.name] = h.value;
    });
    headers = o;
  }
  try {
    chrome.tabs.sendMessage(interceptState.tabId, {
      type: "PAGE_INTERCEPT_DECISION",
      id: id,
      action: decision.action || "forward",
      method: decision.method,
      url: decision.url,
      headers: headers,
      body: decision.body,
      pure: !!decision.pure
    }, function() { /* ignore lastError */ });
  } catch (e) {}
}

function interceptSkipUrl(url) {
  if (!url || typeof url !== "string") return true;
  if (shouldSkip(url)) return true;
  // Never hold extension/devtools traffic
  if (url.indexOf("chrome-extension://") === 0) return true;
  if (url.indexOf("chrome://") === 0 || url.indexOf("edge://") === 0) return true;
  return false;
}

function interceptInScope(url) {
  if (!interceptState.scopeOnly) return true;
  if (!interceptState.domains || !interceptState.domains.length) return true;
  var host;
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return true; }
  return interceptState.domains.some(function(pattern) {
    if (typeof pattern !== "string") return false;
    pattern = pattern.toLowerCase().trim();
    if (!pattern) return false;
    if (pattern.charAt(0) === "/") return false; // skip regex in SW for simplicity
    if (pattern.indexOf("*.") === 0) {
      var suffix = pattern.slice(2);
      return host === suffix || host.endsWith("." + suffix);
    }
    if (pattern.indexOf("*") >= 0) {
      try {
        var re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
        return re.test(host);
      } catch (e) { return false; }
    }
    return host === pattern || host.endsWith("." + pattern);
  });
}

function startIntercept(msg, port) {
  var tabId = parseInt(msg.tabId, 10);
  if (!isFinite(tabId) || tabId < 0) {
    port.postMessage({
      type: "INTERCEPT_STATE",
      active: false,
      error: "Select a valid browser tab first (Standalone → Target Tab, not All Tabs)"
    });
    return;
  }
  if (interceptState.attaching) {
    port.postMessage({ type: "INTERCEPT_STATE", active: false, error: "Already starting intercept…" });
    return;
  }

  interceptState.scopeOnly = !!msg.scopeOnly;
  if (Array.isArray(msg.domains)) {
    interceptState.domains = msg.domains.slice(0, 500).map(String);
  }
  interceptState.stages = {
    request: msg.stageResponse ? true : true,
    response: !!msg.stageResponse
  };
  // Prefer page mode when panel asks (DevTools-safe), else try debugger then page
  var preferPage = msg.preferPage === true || msg.forcePage === true;

  function doneOk(mode) {
    interceptState.attaching = false;
    interceptState.active = true;
    interceptState.tabId = tabId;
    interceptState.mode = mode;
    interceptState.paused = Object.create(null);
    var state = {
      type: "INTERCEPT_STATE",
      active: true,
      tabId: tabId,
      mode: mode,
      queueSize: 0,
      message: mode === "page"
        ? "Page-hook intercept ON (fetch/XHR). Works with DevTools open."
        : "Debugger intercept ON (all HTTP). Banner may appear."
    };
    port.postMessage(state);
    broadcastToDevtools(state);
  }

  function doneErr(err) {
    interceptState.attaching = false;
    interceptState.active = false;
    interceptState.tabId = null;
    interceptState.mode = null;
    port.postMessage({ type: "INTERCEPT_STATE", active: false, error: err });
  }

  function startPageMode(reason) {
    if (!chrome.scripting || !chrome.scripting.executeScript) {
      doneErr((reason ? reason + " — " : "") + "scripting API unavailable for page-hook fallback");
      return;
    }
    chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      files: ["content/intercept-bridge.js"],
      world: "ISOLATED"
    }, function() {
      var e1 = chrome.runtime.lastError && chrome.runtime.lastError.message;
      chrome.scripting.executeScript({
        target: { tabId: tabId, allFrames: true },
        files: ["content/intercept-hook.js"],
        world: "MAIN"
      }, function() {
        var e2 = chrome.runtime.lastError && chrome.runtime.lastError.message;
        if (e1 || e2) {
          doneErr((reason ? reason + " | " : "") + "Page hook failed: " + (e1 || e2) +
            ". Ensure the tab is a normal http(s) page and reload it, then try again.");
          return;
        }
        // Enable hooks
        chrome.tabs.sendMessage(tabId, { type: "PAGE_INTERCEPT_PING", enabled: true }, function() {});
        // Also post enable via executeScript in case message races
        chrome.scripting.executeScript({
          target: { tabId: tabId, allFrames: true },
          world: "MAIN",
          func: function() {
            window.postMessage({ source: "phantom-ix-bridge", type: "enable", enabled: true }, "*");
          }
        }, function() {});
        doneOk("page");
      });
    });
  }

  function startDebuggerMode() {
    if (!chrome.debugger) {
      startPageMode("Debugger API missing");
      return;
    }
    chrome.debugger.attach({ tabId: tabId }, "1.3", function() {
      var err = chrome.runtime.lastError && chrome.runtime.lastError.message;
      if (err) {
        startPageMode(err);
        return;
      }
      var patterns = [{ urlPattern: "*", requestStage: "Request" }];
      if (interceptState.stages.response) {
        patterns.push({ urlPattern: "*", requestStage: "Response" });
      }
      chrome.debugger.sendCommand({ tabId: tabId }, "Fetch.enable", {
        patterns: patterns,
        handleAuthRequests: false
      }, function() {
        var e2 = chrome.runtime.lastError && chrome.runtime.lastError.message;
        if (e2) {
          try { chrome.debugger.detach({ tabId: tabId }); } catch (x) {}
          startPageMode(e2);
          return;
        }
        doneOk("debugger");
      });
    });
  }

  function begin() {
    interceptState.attaching = true;
    if (preferPage) startPageMode(null);
    else startDebuggerMode();
  }

  if (interceptState.active) {
    stopIntercept(function() { begin(); });
  } else {
    begin();
  }
}

function stopIntercept(done) {
  var tabId = interceptState.tabId;
  var mode = interceptState.mode;
  var finish = function(err) {
    interceptState.active = false;
    interceptState.tabId = null;
    interceptState.mode = null;
    interceptState.paused = Object.create(null);
    interceptState.attaching = false;
    if (typeof done === "function") done(err || null);
    broadcastToDevtools({ type: "INTERCEPT_STATE", active: false, queueSize: 0 });
  };
  if (tabId == null) {
    finish(null);
    return;
  }

  var ids = Object.keys(interceptState.paused);

  if (mode === "page") {
    ids.forEach(function(id) {
      pageDecision(id, { action: "drop" });
    });
    try {
      chrome.tabs.sendMessage(tabId, { type: "PAGE_INTERCEPT_PING", enabled: false });
      chrome.scripting.executeScript({
        target: { tabId: tabId, allFrames: true },
        world: "MAIN",
        func: function() {
          window.postMessage({ source: "phantom-ix-bridge", type: "enable", enabled: false }, "*");
        }
      });
    } catch (e) {}
    finish(null);
    return;
  }

  // debugger mode
  var i = 0;
  function failNext() {
    if (i >= ids.length) {
      try {
        chrome.debugger.sendCommand({ tabId: tabId }, "Fetch.disable", {}, function() {
          chrome.debugger.detach({ tabId: tabId }, function() {
            finish(chrome.runtime.lastError && chrome.runtime.lastError.message);
          });
        });
      } catch (e) {
        try { chrome.debugger.detach({ tabId: tabId }); } catch (x) {}
        finish(e.message);
      }
      return;
    }
    var id = ids[i++];
    chrome.debugger.sendCommand({ tabId: tabId }, "Fetch.failRequest", {
      requestId: id,
      errorReason: "Aborted"
    }, function() { failNext(); });
  }
  failNext();
}

function onDebuggerEvent(source, method, params) {
  if (!interceptState.active || interceptState.mode !== "debugger") return;
  if (!source || source.tabId !== interceptState.tabId) return;
  if (method !== "Fetch.requestPaused") return;
  if (!params || !params.requestId) return;

  var stage = params.responseStatusCode != null || params.responseHeaders ? "Response" : "Request";
  var req = params.request || {};
  var url = req.url || params.request && params.request.url || "";

  // Response stage pauses
  if (stage === "Response" && !interceptState.stages.response) {
    chrome.debugger.sendCommand({ tabId: source.tabId }, "Fetch.continueRequest", {
      requestId: params.requestId
    });
    return;
  }
  if (stage === "Request" && !params.request) {
    chrome.debugger.sendCommand({ tabId: source.tabId }, "Fetch.continueRequest", {
      requestId: params.requestId
    });
    return;
  }

  url = (req.url || url || "");
  if (interceptSkipUrl(url) || !interceptInScope(url)) {
    chrome.debugger.sendCommand({ tabId: source.tabId }, "Fetch.continueRequest", {
      requestId: params.requestId
    });
    return;
  }

  if (Object.keys(interceptState.paused).length >= MAX_INTERCEPT_QUEUE) {
    chrome.debugger.sendCommand({ tabId: source.tabId }, "Fetch.continueRequest", {
      requestId: params.requestId
    });
    broadcastToDevtools({
      type: "INTERCEPT_OVERFLOW",
      message: "Intercept queue full (" + MAX_INTERCEPT_QUEUE + ") — new requests auto-forwarded"
    });
    return;
  }

  var headers = Object.create(null);
  if (req.headers && typeof req.headers === "object") {
    Object.keys(req.headers).forEach(function(k) {
      if (!isSafeKey(k)) return;
      headers[sanitizeToken(k) || k] = sanitizeValue(String(req.headers[k]));
    });
  }
  // Response headers if present
  var resHeaders = Object.create(null);
  if (params.responseHeaders && Array.isArray(params.responseHeaders)) {
    params.responseHeaders.forEach(function(h) {
      if (h && h.name) resHeaders[sanitizeToken(h.name)] = sanitizeValue(String(h.value || ""));
    });
  }

  var body = null;
  if (typeof req.postData === "string" && req.postData.length) {
    body = req.postData.slice(0, MAX_BODY_BYTES);
  } else if (req.postDataEntries && req.postDataEntries.length) {
    try {
      // postDataEntries[].bytes are base64
      var chunks = [];
      for (var pi = 0; pi < req.postDataEntries.length; pi++) {
        var ent = req.postDataEntries[pi];
        if (ent && ent.bytes) chunks.push(atob(ent.bytes));
      }
      body = chunks.join("").slice(0, MAX_BODY_BYTES);
    } catch (e) {
      body = null;
    }
  }

  var entry = {
    networkId: params.requestId,
    tabId: source.tabId,
    url: String(url).slice(0, 8192),
    method: sanitizeMethod(req.method || "GET"),
    headers: headers,
    body: body,
    hasPostData: !!(req.hasPostData || (body && body.length)),
    resourceType: params.resourceType || "",
    stage: stage,
    mode: "debugger",
    responseStatus: params.responseStatusCode || null,
    responseHeaders: resHeaders,
    timestamp: Date.now()
  };
  interceptState.paused[params.requestId] = entry;

  broadcastToDevtools({
    type: "INTERCEPT_PAUSED",
    request: entry,
    queueSize: Object.keys(interceptState.paused).length
  });
}

function onDebuggerDetach(source, reason) {
  if (!source || source.tabId !== interceptState.tabId) return;
  interceptState.active = false;
  interceptState.tabId = null;
  interceptState.paused = Object.create(null);
  broadcastToDevtools({
    type: "INTERCEPT_STATE",
    active: false,
    error: reason ? "Debugger detached: " + reason : "Debugger detached",
    queueSize: 0
  });
}

if (chrome.debugger && chrome.debugger.onEvent) {
  chrome.debugger.onEvent.addListener(onDebuggerEvent);
}
if (chrome.debugger && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener(onDebuggerDetach);
}

function parseHeaderLines(text) {
  var h = [];
  String(text || "").split(/\r?\n/).forEach(function(line) {
    line = line.replace(/[\r\n\0]/g, "").trim();
    if (!line || line.charAt(0) === "#") return;
    var c = line.indexOf(":");
    if (c <= 0) return;
    var name = sanitizeToken(line.slice(0, c).trim());
    // Keep header values mostly intact — only strip CR/LF/NUL (needed for body length accuracy)
    var value = String(line.slice(c + 1)).replace(/[\r\n\0]/g, " ").trim().slice(0, 64 * 1024);
    if (!name || !isSafeKey(name)) return;
    h.push({ name: name, value: value });
  });
  return h;
}

function methodAllowsBody(method) {
  var m = String(method || "").toUpperCase();
  // RFC: body allowed on any method except TRACE; browsers commonly use body on these
  return m !== "GET" && m !== "HEAD" && m !== "TRACE";
}

function headersObjectToText(obj) {
  if (!obj) return "";
  return Object.keys(obj).map(function(k) { return k + ": " + obj[k]; }).join("\n");
}

function setHeaderInList(list, name, value) {
  var lower = name.toLowerCase();
  var found = false;
  for (var i = 0; i < list.length; i++) {
    if (list[i].name.toLowerCase() === lower) {
      list[i].value = value;
      found = true;
    }
  }
  if (!found) list.push({ name: name, value: value });
  return list;
}

function removeHeaderFromList(list, name) {
  var lower = name.toLowerCase();
  return list.filter(function(h) { return h.name.toLowerCase() !== lower; });
}

/**
 * UTF-8 byte length of a JS string (for Content-Length).
 */
function utf8ByteLength(str) {
  try {
    return new TextEncoder().encode(str).length;
  } catch (e) {
    // Fallback
    var s = encodeURIComponent(str);
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      if (s.charAt(i) === "%") { n++; i += 2; }
      else n++;
    }
    return n;
  }
}

function forwardIntercepted(msg, port) {
  if (!interceptState.active || interceptState.tabId == null) {
    port.postMessage({ type: "INTERCEPT_ERROR", error: "Intercept is not active" });
    return;
  }
  var id = typeof msg.networkId === "string" ? msg.networkId : "";
  if (!id || !interceptState.paused[id]) {
    port.postMessage({ type: "INTERCEPT_ERROR", error: "Unknown paused request" });
    return;
  }
  var original = interceptState.paused[id];

  var url = original.url;
  var urlChanged = false;
  if (typeof msg.url === "string" && msg.url.trim()) {
    var uerr = validateURL(msg.url.trim());
    if (uerr) {
      port.postMessage({ type: "INTERCEPT_ERROR", error: "URL blocked: " + uerr });
      return;
    }
    if (msg.url.trim() !== original.url) {
      url = msg.url.trim().slice(0, 8192);
      urlChanged = true;
    }
  }

  var method = original.method;
  var methodChanged = false;
  if (typeof msg.method === "string") {
    var m = sanitizeMethod(msg.method);
    if (m && m !== original.method) {
      method = m;
      methodChanged = true;
    } else if (m) {
      method = m;
    }
  }

  var origBody = original.body != null ? String(original.body) : "";
  var bodyProvided = typeof msg.body === "string";
  var body = bodyProvided ? msg.body.slice(0, MAX_BODY_BYTES) : origBody;
  // Detect body edit (normalize for comparison)
  var bodyChanged = bodyProvided && body !== origBody;

  var origHeadersText = headersObjectToText(original.headers || {});
  var headersProvided = typeof msg.headersText === "string";
  var headersChanged = headersProvided && msg.headersText.replace(/\r\n/g, "\n").trim() !== origHeadersText.replace(/\r\n/g, "\n").trim();
  var headerList = headersProvided ? parseHeaderLines(msg.headersText) : null;

  // Pure forward (no edits) — only requestId so the browser keeps the original
  // POST/PUT body intact (critical: do NOT send empty postData).
  var pureForward = !urlChanged && !methodChanged && !headersChanged && !bodyChanged;

  // ── Page-hook mode ──
  if (interceptState.mode === "page" || original.mode === "page") {
    var hdrObj = Object.create(null);
    if (headerList) {
      headerList.forEach(function(h) { hdrObj[h.name] = h.value; });
    } else {
      Object.keys(original.headers || {}).forEach(function(k) {
        hdrObj[k] = original.headers[k];
      });
    }
    // For pure forward, tell hook to use original body (body: undefined)
    var decision = {
      action: "forward",
      method: method,
      url: url,
      headers: pureForward ? null : hdrObj,
      // undefined body = keep original raw body (FormData/Blob/string)
      body: pureForward ? undefined : (methodAllowsBody(method) ? body : null),
      pure: pureForward
    };
    pageDecision(id, decision);
    delete interceptState.paused[id];
    var q1 = Object.keys(interceptState.paused).length;
    broadcastToDevtools({ type: "INTERCEPT_RELEASED", networkId: id, action: "forward", queueSize: q1 });
    return;
  }

  // ── Debugger response stage ──
  if (original.stage === "Response") {
    chrome.debugger.sendCommand({ tabId: interceptState.tabId }, "Fetch.continueRequest", {
      requestId: id
    }, function() {
      delete interceptState.paused[id];
      var q = Object.keys(interceptState.paused).length;
      broadcastToDevtools({ type: "INTERCEPT_RELEASED", networkId: id, action: "forward", queueSize: q });
    });
    return;
  }

  // ── Debugger request stage ──
  var params = { requestId: id };

  if (pureForward) {
    // Do not override method/headers/body — preserves POST payloads
    chrome.debugger.sendCommand({ tabId: interceptState.tabId }, "Fetch.continueRequest", params, function() {
      var err = chrome.runtime.lastError && chrome.runtime.lastError.message;
      delete interceptState.paused[id];
      var q = Object.keys(interceptState.paused).length;
      if (err) {
        port.postMessage({ type: "INTERCEPT_ERROR", error: err, networkId: id, queueSize: q });
      } else {
        broadcastToDevtools({ type: "INTERCEPT_RELEASED", networkId: id, action: "forward", queueSize: q });
      }
    });
    return;
  }

  if (urlChanged) params.url = url;
  if (methodChanged || method) params.method = method;

  // Body: only override when user edited it OR headers force a rewrite with known body
  if (bodyChanged && methodAllowsBody(method)) {
    params.postData = body;
  } else if (headersChanged && methodAllowsBody(method) && origBody) {
    // When rewriting headers we must re-supply postData or some Chromium builds drop it
    params.postData = origBody;
    body = origBody;
  }

  if (headersChanged || bodyChanged) {
    var list = headerList ? headerList.slice() : parseHeaderLines(origHeadersText);
    // Strip hop-by-hop / auto headers that break re-issue
    list = removeHeaderFromList(list, "content-length");
    list = removeHeaderFromList(list, "host");
    list = removeHeaderFromList(list, "transfer-encoding");
    if (params.postData != null && methodAllowsBody(method)) {
      setHeaderInList(list, "Content-Length", String(utf8ByteLength(String(params.postData))));
    }
    // Ensure Content-Type kept from original if user removed it but body remains
    if (params.postData != null && methodAllowsBody(method)) {
      var hasCT = list.some(function(h) { return h.name.toLowerCase() === "content-type"; });
      if (!hasCT && original.headers) {
        Object.keys(original.headers).forEach(function(k) {
          if (k.toLowerCase() === "content-type") {
            setHeaderInList(list, "Content-Type", original.headers[k]);
          }
        });
      }
    }
    params.headers = list;
  }

  chrome.debugger.sendCommand({ tabId: interceptState.tabId }, "Fetch.continueRequest", params, function() {
    var err = chrome.runtime.lastError && chrome.runtime.lastError.message;
    // Retry pure continue if modified continue failed (body encoding issues)
    if (err && !pureForward) {
      chrome.debugger.sendCommand({ tabId: interceptState.tabId }, "Fetch.continueRequest", {
        requestId: id
      }, function() {
        var err2 = chrome.runtime.lastError && chrome.runtime.lastError.message;
        delete interceptState.paused[id];
        var q = Object.keys(interceptState.paused).length;
        if (err2) {
          port.postMessage({ type: "INTERCEPT_ERROR", error: err + " | retry: " + err2, networkId: id, queueSize: q });
        } else {
          broadcastToDevtools({ type: "INTERCEPT_RELEASED", networkId: id, action: "forward", queueSize: q });
          port.postMessage({ type: "INTERCEPT_ERROR", error: "Modified forward failed; original request was forwarded instead: " + err });
        }
      });
      return;
    }
    delete interceptState.paused[id];
    var q = Object.keys(interceptState.paused).length;
    if (err) {
      port.postMessage({ type: "INTERCEPT_ERROR", error: err, networkId: id, queueSize: q });
    } else {
      broadcastToDevtools({ type: "INTERCEPT_RELEASED", networkId: id, action: "forward", queueSize: q });
    }
  });
}

function dropIntercepted(msg, port) {
  if (!interceptState.active || interceptState.tabId == null) {
    port.postMessage({ type: "INTERCEPT_ERROR", error: "Intercept is not active" });
    return;
  }
  var id = typeof msg.networkId === "string" ? msg.networkId : "";
  if (!id || !interceptState.paused[id]) {
    port.postMessage({ type: "INTERCEPT_ERROR", error: "Unknown paused request" });
    return;
  }
  var original = interceptState.paused[id];

  if (interceptState.mode === "page" || original.mode === "page") {
    pageDecision(id, { action: "drop" });
    delete interceptState.paused[id];
    var q1 = Object.keys(interceptState.paused).length;
    broadcastToDevtools({ type: "INTERCEPT_RELEASED", networkId: id, action: "drop", queueSize: q1 });
    return;
  }

  chrome.debugger.sendCommand({ tabId: interceptState.tabId }, "Fetch.failRequest", {
    requestId: id,
    errorReason: "BlockedByClient"
  }, function() {
    delete interceptState.paused[id];
    var q = Object.keys(interceptState.paused).length;
    broadcastToDevtools({ type: "INTERCEPT_RELEASED", networkId: id, action: "drop", queueSize: q });
  });
}

function forwardAllIntercepted(port) {
  var ids = Object.keys(interceptState.paused);
  if (!ids.length) {
    port.postMessage({ type: "INTERCEPT_ERROR", error: "Queue empty" });
    return;
  }
  var i = 0;
  function next() {
    if (i >= ids.length) return;
    var id = ids[i++];
    forwardIntercepted({ networkId: id }, port);
    setTimeout(next, 30);
  }
  next();
}

function dropAllIntercepted(port) {
  var ids = Object.keys(interceptState.paused);
  if (!ids.length) {
    port.postMessage({ type: "INTERCEPT_ERROR", error: "Queue empty" });
    return;
  }
  ids.forEach(function(id) {
    dropIntercepted({ networkId: id }, port);
  });
}
