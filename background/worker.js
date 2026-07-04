// PhantomProxy — Background Service Worker v2.2 (Debugger Only)
// Uses chrome.debugger (CDP) for everything — no webRequest needed
"use strict";

var MAX_REQUESTS       = 500;
var MAX_BODY_BYTES     = 64 * 1024;
var MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
var ALLOWED_SCHEMES    = ["http:", "https:"];
var ALLOWED_METHODS    = ["GET","POST","PUT","PATCH","DELETE","OPTIONS","HEAD"];

// ─── FIX 1: Remove private IP block ───────────────────
var BLOCKED_HOSTS = [
  /^localhost$/i, /^127\./, /^0\.0\.0\.0$/
  // Private IPs now allowed for testing
  // /^10\./,
  // /^172\.(1[6-9]|2\d|3[01])\./,
  // /^192\.168\./,
  // /^169\.254\./,
  // /^::1$/, /^fc00:/i, /^fe80:/i
];

var requestStore  = [];
var requestMap    = {};
var devtoolsPorts = {};
var portCounter   = 0;

// ─── FIX 2: Store cookies per tab ─────────────────────
var tabCookies = {};

// ─── Keep service worker alive while ports connected ──
var keepAliveInterval = null;

function startKeepalive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(function() {
    chrome.runtime.getPlatformInfo(function() {});
  }, 25000);
}

function stopKeepalive() {
  if (Object.keys(devtoolsPorts).length === 0 && keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// ─── DEBUGGER STATE ────────────────────────────────────
var debuggerActive = false;
var debuggerAttachedTabs = {};

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
    var err = validateRepeaterRequest(req);
    if (err) {
      port.postMessage({
        type: "REPEATER_RESPONSE",
        id: req.id || null,
        result: { success: false, error: "Blocked: " + err }
      });
      return;
    }
    sendRepeaterRequest(req).then(function(result) {
      port.postMessage({ type: "REPEATER_RESPONSE", id: req.id, result: result });
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

  // ─── DEBUGGER MESSAGE HANDLERS ───────────────────────
  if (msg.type === "START_DEBUGGER") {
    startDebugger();
    return;
  }

  if (msg.type === "STOP_DEBUGGER") {
    stopDebugger();
    return;
  }
}

// ─── DEBUGGER CONTROL ──────────────────────────────────

function startDebugger() {
  if (debuggerActive) return;

  chrome.tabs.query({}, function(tabs) {
    tabs.forEach(function(tab) {
      if (tab.url && tab.url.startsWith("http")) {
        chrome.debugger.attach({ tabId: tab.id }, "1.3", function() {
          if (chrome.runtime.lastError) {
            return;
          }
          chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable");
          debuggerAttachedTabs[tab.id] = true;
        });
      }
    });
    debuggerActive = true;
  });
}

function stopDebugger() {
  if (!debuggerActive) return;

  Object.keys(debuggerAttachedTabs).forEach(function(tabId) {
    chrome.debugger.detach({ tabId: parseInt(tabId, 10) }, function() {
      // Ignore errors
    });
  });

  debuggerAttachedTabs = {};
  debuggerActive = false;
}

// ─── DEBUGGER EVENTS ───────────────────────────────────

var pendingHeaders = {};

chrome.debugger.onEvent.addListener(function(source, eventMethod, params) {
  if (!debuggerActive) return;

  var key = params.requestId;

  // 1. Request sent — capture body and basic info
  if (eventMethod === "Network.requestWillBeSent") {
    var request = params.request;

    // ✅ Store basic headers from requestWillBeSent (may be incomplete)
    var basicHeaders = request.headers || {};

    var entry = {
      id: key + "_" + Date.now(),
      requestId: key,
      url: request.url,
      method: request.method,
      timestamp: Date.now(),
      tabId: source.tabId,
      type: params.type || 'other',
      status: "pending",
      requestBody: request.postData || null,
      requestHeaders: [], // Will be filled by ExtraInfo
      responseHeaders: {},
      statusCode: null,
      duration: null,
      _start: Date.now(),
      contentType: null,
      _finalized: false
    };

    // ✅ If we already have headers from ExtraInfo (fired before), use them
    if (pendingHeaders[key]) {
      entry.requestHeaders = pendingHeaders[key];
      delete pendingHeaders[key];
    } else {
      // Store basic headers as fallback
      entry.requestHeaders = basicHeaders;
    }

    requestMap[key] = entry;
  }

  // 2. Extra Info — COMPLETE headers (Cookie, Accept-Encoding, Sec-Fetch-*)
  if (eventMethod === "Network.requestWillBeSentExtraInfo") {
    var entry = requestMap[key];

    if (entry) {
      // ✅ Complete headers with original order
      entry.requestHeaders = params.headers || [];
    } else {
      // Entry not created yet (requestWillBeSent fired after ExtraInfo)
      pendingHeaders[key] = params.headers || [];
    }
  }

  // 3. Response received
  if (eventMethod === "Network.responseReceived") {
    var entry = requestMap[key];
    if (entry) {
      entry.statusCode = params.response.status;
      entry.responseHeaders = params.response.headers || {};
    }
  }

  // 4. Response body
  if (eventMethod === "Network.loadingFinished") {
    var entry = requestMap[key];
    if (entry) {
      entry.duration = Date.now() - (entry._start || Date.now());
      delete entry._start;

      chrome.debugger.sendCommand(
        { tabId: entry.tabId || source.tabId },
        "Network.getResponseBody",
        { requestId: params.requestId },
        function(bodyResponse) {
          if (bodyResponse && !chrome.runtime.lastError) {
            entry.responseBody = bodyResponse.body || null;
          }
          finalizeRequest(entry);
          delete requestMap[key];
          delete pendingHeaders[key];
        }
      );
    }
  }
});

// ─── Handle debugger detach ───────────────────────────
chrome.debugger.onDetach.addListener(function(source, reason) {
  var tabId = source.tabId;
  if (tabId && debuggerAttachedTabs[tabId]) {
    delete debuggerAttachedTabs[tabId];
  }

  if (Object.keys(debuggerAttachedTabs).length === 0) {
    debuggerActive = false;
  }
});

// ─── TYPE MAPPING ──────────────────────────────────────
function mapDebuggerType(type) {
  var map = {
    'Document': 'main_frame',
    'Stylesheet': 'stylesheet',
    'Script': 'script',
    'Image': 'image',
    'Font': 'font',
    'XHR': 'xmlhttprequest',
    'Fetch': 'xmlhttprequest',
    'WebSocket': 'websocket',
    'Preflight': 'xmlhttprequest'
  };
  return map[type] || 'other';
}

// ─── FINALIZE REQUEST ──────────────────────────────────
function finalizeRequest(entry) {
  if (entry._finalized) return;
  entry._finalized = true;

  // 1. Use debugger type if available
  if (entry.type && typeof entry.type === 'string') {
    var mappedType = mapDebuggerType(entry.type);
    if (mappedType) entry.type = mappedType;
  }

  // 2. Ensure headers are in the right format (array)
  if (!Array.isArray(entry.requestHeaders)) {
    // If it's an object, convert to array
    if (typeof entry.requestHeaders === 'object') {
      var arr = [];
      Object.keys(entry.requestHeaders).forEach(function(k) {
        arr.push({ name: k, value: entry.requestHeaders[k] });
      });
      entry.requestHeaders = arr;
    } else {
      entry.requestHeaders = [];
    }
  }

  // 3. Ensure body is a string
  if (entry.requestBody !== null && entry.requestBody !== undefined) {
    if (typeof entry.requestBody === 'object') {
      entry.requestBody = JSON.stringify(entry.requestBody);
    } else if (typeof entry.requestBody !== 'string') {
      entry.requestBody = String(entry.requestBody);
    }
  }

  // 4. Store
  if (requestStore.length >= MAX_REQUESTS) requestStore.shift();
  requestStore.push(entry);
  broadcastToDevtools({ type: "NEW_REQUEST", request: entry });
}

// ─── URL Validation ───────────────────────────────────
function validateURL(url) {
  var parsed;
  try { parsed = new URL(url); } catch(e) { return "Invalid URL"; }
  if (ALLOWED_SCHEMES.indexOf(parsed.protocol) === -1) {
    return "Scheme '" + parsed.protocol + "' not allowed";
  }
  var host = parsed.hostname.toLowerCase();
  for (var i = 0; i < BLOCKED_HOSTS.length; i++) {
    if (BLOCKED_HOSTS[i].test(host)) return "Hostname '" + host + "' is blocked";
  }
  return null;
}

function validateRepeaterRequest(req) {
  if (!req.method || ALLOWED_METHODS.indexOf(req.method.toUpperCase()) === -1) {
    return "Method '" + req.method + "' not allowed";
  }
  return validateURL(req.url);
}

// ─── Repeater Fetch ───────────────────────────────────
async function sendRepeaterRequest(req) {
  var start = Date.now();
  try {
    var method = req.method.toUpperCase();
    var safeHeaders = {};
    var raw = req.requestHeaders || {};

    if (Array.isArray(raw)) {
      raw.forEach(function(h) {
        if (h && h.name) {
          var name = sanitizeToken(h.name);
          var value = sanitizeValue(h.value);
          if (name) safeHeaders[name] = value;
        }
      });
    } else {
      Object.keys(raw).forEach(function(k) {
        if (!Object.prototype.hasOwnProperty.call(raw, k)) return;
        var name = sanitizeToken(k);
        var value = sanitizeValue(raw[k]);
        if (!name) return;
        var lower = name.toLowerCase();
        if (["transfer-encoding"].indexOf(lower) >= 0) return;
        safeHeaders[name] = value;
      });
    }

    var urlObj = new URL(req.url);

    if (!safeHeaders['Host']) {
      safeHeaders['Host'] = urlObj.host;
    }
    if (!safeHeaders['Origin']) {
      safeHeaders['Origin'] = urlObj.origin;
    }
    if (!safeHeaders['Referer']) {
      safeHeaders['Referer'] = urlObj.origin + '/';
    }

    if (!safeHeaders['Cookie'] && req.tabId && tabCookies[req.tabId]) {
      safeHeaders['Cookie'] = tabCookies[req.tabId];
    }

    var options = { method: method, headers: safeHeaders, redirect: "manual" };
    if (method !== "GET" && method !== "HEAD" && req.requestBody) {
      options.body = req.requestBody.slice(0, MAX_BODY_BYTES);
    }

    safeHeaders['Connection'] = 'keep-alive';

    if (options.body) {
      var bodyLength = new Blob([options.body]).size;
      safeHeaders['Content-Length'] = String(bodyLength);
    }

    options.headers = safeHeaders;

    var response = await fetch(req.url, options);
    var duration = Date.now() - start;
    var resHeaders = {};
    response.headers.forEach(function(val, key) {
      resHeaders[sanitizeToken(key)] = sanitizeValue(val);
    });

    var body = "";
    var ct = response.headers.get("content-type") || "";
    var isText = ct.indexOf("text") >= 0 || ct.indexOf("json") >= 0 ||
      ct.indexOf("xml") >= 0 || ct.indexOf("javascript") >= 0;

    if (response.status >= 300 && response.status < 400) isText = true;

    if (isText) {
      var reader = response.body.getReader();
      var chunks = [];
      var total = 0;
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
      if (truncated) body += "\n\n[... truncated at " + (MAX_RESPONSE_BYTES / 1024) + "KB ...]";
    } else {
      body = "[Binary response — not displayed]";
    }

    return {
      success: true, statusCode: response.status, statusText: response.statusText,
      responseHeaders: resHeaders, body: body, duration: duration, size: body.length
    };
  } catch (err) {
    return { success: false, error: err.message, duration: Date.now() - start };
  }
}

// ─── Sanitization ─────────────────────────────────────
var ALLOWED_TYPES = ["main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other"
];

function sanitizeMethod(m) {
  var u = String(m || "").toUpperCase();
  return ALLOWED_METHODS.indexOf(u) >= 0 ? u : "GET";
}

function sanitizeType(t) {
  return ALLOWED_TYPES.indexOf(t) >= 0 ? t : "other";
}

function sanitizeToken(name) {
  if (typeof name !== "string") return "";
  return name.replace(/[\r\n\0]/g, "").trim();
}

function sanitizeValue(value) {
  if (typeof value !== "string") return String(value == null ? "" : value);
  return value.replace(/[\r\n\0]/g, " ").trim();
}

function shouldSkip(url) {
  return url.startsWith("chrome-extension://") || url.startsWith("chrome://") ||
    url.startsWith("devtools://") || url.startsWith("about:") ||
    url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("file:");
}

// ─── Old extractBody (kept for compatibility) ─────────
function extractBody(requestBody) {
  if (!requestBody) return null;

  if (requestBody.raw) {
    try {
      var bytes = new Uint8Array(requestBody.raw[0].bytes);
      var text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      return text;
    } catch (e) {
      return "[binary body]";
    }
  }

  if (requestBody.formData) {
    var parts = [];
    var keys = Object.keys(requestBody.formData);
    keys.forEach(function(key) {
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(requestBody.formData[key]));
    });
    return parts.join("&").slice(0, MAX_BODY_BYTES);
  }

  return null;
}