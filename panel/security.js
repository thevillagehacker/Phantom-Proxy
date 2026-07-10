// PhantomProxy v2.2.0 — Shared security utilities
// Used by panel.js, features.js, and advanced.js
// Keep pure: no DOM, no chrome.* side effects except where noted.
"use strict";

var PhantomSecurity = (function () {
  var MAX_REGEX_LEN     = 200;
  var MAX_STRING_SCAN   = 256 * 1024; // 256KB scan cap (ReDoS / DoS)
  // Intruder payload cap — raised for wordlists; still bounds browser DoS
  var MAX_PAYLOADS      = 500;
  var MAX_PROJECT_BYTES = 15 * 1024 * 1024; // 15MB project import
  var MAX_NOTE_LEN      = 2000;
  var MAX_TAG_LEN       = 40;
  var MAX_TAGS          = 20;

  var ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
  var ALLOWED_SCHEMES = ["http:", "https:"];
  var ALLOWED_WS      = ["ws:", "wss:"];

  // Private / link-local / metadata — deny list for outbound tools
  var BLOCKED_HOST_RES = [
    /^localhost$/i,
    /^127\./,
    /^0\.0\.0\.0$/,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,           // link-local + cloud metadata
    /^::1$/,
    /^fc00:/i,
    /^fd[0-9a-f]{2}:/i,
    /^fe80:/i,
    /^0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,1}1$/i,
    /\.local$/i,
    /\.localhost$/i,
    /\.internal$/i,
    /^metadata\.google\.internal$/i
  ];

  function stripCrLf(s) {
    if (typeof s !== "string") return String(s == null ? "" : s);
    return s.replace(/[\r\n\0]/g, " ");
  }

  function sanitizeToken(name) {
    if (typeof name !== "string") return "";
    // Header names: token chars only (RFC 7230), plus strip CR/LF/NUL
    return name.replace(/[\r\n\0]/g, "").replace(/[^\w!#$%&'*+.^`|~-]/g, "").trim().slice(0, 256);
  }

  function sanitizeValue(value) {
    if (typeof value !== "string") return String(value == null ? "" : value);
    return value.replace(/[\r\n\0]/g, " ").slice(0, 64 * 1024);
  }

  function hasOwn(obj, key) {
    return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** Reject prototype-pollution keys */
  function isSafeKey(k) {
    if (typeof k !== "string" || !k) return false;
    var lower = k.toLowerCase();
    return lower !== "__proto__" && lower !== "constructor" && lower !== "prototype";
  }

  /**
   * Compile a user regex safely.
   * - Length cap
   * - Flag whitelist
   * - Reject obvious catastrophic patterns (nested quantifiers)
   * Returns { ok, re?, error? }
   */
  function safeRegExp(source, flags) {
    if (typeof source !== "string") return { ok: false, error: "Pattern must be a string" };
    if (source.length === 0) return { ok: false, error: "Empty pattern" };
    if (source.length > MAX_REGEX_LEN) {
      return { ok: false, error: "Pattern too long (max " + MAX_REGEX_LEN + " chars)" };
    }
    flags = typeof flags === "string" ? flags : "";
    if (!/^[gimsuy]{0,6}$/.test(flags)) {
      return { ok: false, error: "Invalid regex flags" };
    }
    // Heuristic ReDoS guard: nested quantifiers like (a+)+ or (a*)*
    if (/(\([^)]*[+*][^)]*\))[+*]|([+*]\s*){2,}/.test(source) &&
        /(\+|\*|\{)\s*\)\s*(\+|\*|\{)/.test(source.replace(/\\\(/g, ""))) {
      // softer check — block (x+)+ style
    }
    if (/\([^)]*[+*{][^)]*\)[+*{]/.test(source)) {
      return { ok: false, error: "Pattern rejected (nested quantifiers / ReDoS risk)" };
    }
    try {
      return { ok: true, re: new RegExp(source, flags) };
    } catch (e) {
      return { ok: false, error: e.message || "Invalid regex" };
    }
  }

  /**
   * Parse /pattern/flags form or plain string (literal search when not regex mode).
   */
  function compileUserPattern(input, asRegex) {
    input = String(input || "");
    if (!asRegex) {
      return { ok: true, test: function (text) {
        if (typeof text !== "string") text = String(text == null ? "" : text);
        if (text.length > MAX_STRING_SCAN) text = text.slice(0, MAX_STRING_SCAN);
        return text.toLowerCase().indexOf(input.toLowerCase()) >= 0;
      }, literal: input };
    }
    var body = input;
    var flags = "i";
    if (input.charAt(0) === "/" && input.lastIndexOf("/") > 0) {
      var last = input.lastIndexOf("/");
      body  = input.slice(1, last);
      flags = input.slice(last + 1) || "i";
    }
    var r = safeRegExp(body, flags);
    if (!r.ok) return r;
    return {
      ok: true,
      test: function (text) {
        if (typeof text !== "string") text = String(text == null ? "" : text);
        if (text.length > MAX_STRING_SCAN) text = text.slice(0, MAX_STRING_SCAN);
        r.re.lastIndex = 0;
        return r.re.test(text);
      },
      re: r.re
    };
  }

  function isBlockedHostname(host) {
    if (!host || typeof host !== "string") return true;
    host = host.toLowerCase().replace(/^\[|\]$/g, "");
    // Decimal / octal IP tricks — if pure digits, treat as IPv4 int
    if (/^\d+$/.test(host)) {
      var n = parseInt(host, 10);
      if (n <= 0xffffffff) {
        var a = (n >>> 24) & 255, b = (n >>> 16) & 255, c = (n >>> 8) & 255, d = n & 255;
        host = a + "." + b + "." + c + "." + d;
      }
    }
    for (var i = 0; i < BLOCKED_HOST_RES.length; i++) {
      if (BLOCKED_HOST_RES[i].test(host)) return true;
    }
    // IPv4-mapped IPv6 :ffff:127.0.0.1
    var m = host.match(/^:ffff:(\d+\.\d+\.\d+\.\d+)$/i) ||
            host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (m) {
      for (var j = 0; j < BLOCKED_HOST_RES.length; j++) {
        if (BLOCKED_HOST_RES[j].test(m[1])) return true;
      }
    }
    return false;
  }

  function validateHttpUrl(url, opts) {
    opts = opts || {};
    var schemes = opts.websocket ? ALLOWED_WS.concat(ALLOWED_SCHEMES) : ALLOWED_SCHEMES;
    if (opts.websocketOnly) schemes = ALLOWED_WS;
    var parsed;
    try { parsed = new URL(url); } catch (e) { return "Invalid URL"; }
    if (schemes.indexOf(parsed.protocol) === -1) {
      return "Scheme '" + parsed.protocol + "' not allowed";
    }
    var host = parsed.hostname.toLowerCase();
    if (!host) return "Missing hostname";
    if (host.indexOf("%") >= 0) return "Encoded hostnames blocked";
    if (isBlockedHostname(host)) return "Hostname '" + host + "' is blocked (private/metadata)";
    // Credentials in URL can leak to logs — strip warning only, still allow for testing
    if (url.length > 8192) return "URL too long";
    return null;
  }

  function validateMethod(m) {
    var u = String(m || "").toUpperCase();
    return ALLOWED_METHODS.indexOf(u) >= 0 ? u : null;
  }

  function clampNote(s) {
    s = stripCrLf(String(s == null ? "" : s)).trim();
    return s.slice(0, MAX_NOTE_LEN);
  }

  function clampTag(s) {
    s = String(s == null ? "" : s).trim().replace(/[^\w\-.:@/+]/g, "").slice(0, MAX_TAG_LEN);
    return s;
  }

  function clampTags(arr) {
    if (!Array.isArray(arr)) return [];
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < arr.length && out.length < MAX_TAGS; i++) {
      var t = clampTag(arr[i]);
      if (!t || seen[t]) continue;
      seen[t] = true;
      out.push(t);
    }
    return out;
  }

  /** Safe JSON.parse with size guard */
  function safeJsonParse(text, maxBytes) {
    maxBytes = maxBytes || MAX_PROJECT_BYTES;
    if (typeof text !== "string") return { ok: false, error: "Not a string" };
    if (text.length > maxBytes) return { ok: false, error: "File too large (max " + Math.round(maxBytes / 1024 / 1024) + "MB)" };
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: "Invalid JSON: " + (e.message || "parse error") };
    }
  }

  /**
   * HTML entity decode without using element.innerHTML (XSS-safe).
   */
  function htmlDecode(str) {
    return String(str)
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#(\d+);/g, function (_, n) {
        var code = parseInt(n, 10);
        if (!isFinite(code) || code < 0 || code > 0x10ffff) return "";
        try { return String.fromCodePoint(code); } catch (e) { return ""; }
      })
      .replace(/&amp;/g, "&");
  }

  function htmlEncode(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Cap payload list for fuzzer */
  function clampPayloads(text) {
    var lines = String(text || "").split(/\r?\n/);
    var out = [];
    for (var i = 0; i < lines.length && out.length < MAX_PAYLOADS; i++) {
      var line = lines[i];
      if (line.length > 4096) line = line.slice(0, 4096);
      out.push(line);
    }
    return out;
  }

  return {
    MAX_REGEX_LEN: MAX_REGEX_LEN,
    MAX_PAYLOADS: MAX_PAYLOADS,
    MAX_PROJECT_BYTES: MAX_PROJECT_BYTES,
    MAX_STRING_SCAN: MAX_STRING_SCAN,
    ALLOWED_METHODS: ALLOWED_METHODS,
    stripCrLf: stripCrLf,
    sanitizeToken: sanitizeToken,
    sanitizeValue: sanitizeValue,
    hasOwn: hasOwn,
    isSafeKey: isSafeKey,
    safeRegExp: safeRegExp,
    compileUserPattern: compileUserPattern,
    isBlockedHostname: isBlockedHostname,
    validateHttpUrl: validateHttpUrl,
    validateMethod: validateMethod,
    clampNote: clampNote,
    clampTag: clampTag,
    clampTags: clampTags,
    safeJsonParse: safeJsonParse,
    htmlDecode: htmlDecode,
    htmlEncode: htmlEncode,
    clampPayloads: clampPayloads
  };
})();

// Global for classic scripts
if (typeof window !== "undefined") window.PhantomSecurity = PhantomSecurity;
