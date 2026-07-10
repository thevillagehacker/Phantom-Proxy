// PhantomProxy v2.3.0 — Advanced features
// Sitemap | Search | Diff | Compare | Match-Replace | Intruder | Params | Cookies | Issues
// Security: textContent-only rendering, capped regex, SSRF-aware outbound helpers
"use strict";

var PhantomAdvanced = (function () {
  var S = window.PhantomSecurity;
  if (!S) {
    console.error("PhantomAdvanced requires security.js");
    return {};
  }

  // ── Callbacks injected at init ──
  var api = {
    getRequests: function () { return []; },
    setRequests: null,          // function(arr)
    getBookmarks: function () { return {}; },
    setBookmarks: null,
    getNotes: function () { return {}; },
    setNotes: null,
    getScope: function () { return null; },
    setStatus: function () {},
    switchTab: function () {},
    createSession: function () {},
    sendBg: function () {},
    selectRequest: function () {},
    renderList: function () {},
    getRepeaterSessions: function () { return []; },
    getActiveSession: function () { return null; },
    getLastResponse: function () { return { body: "", headers: {}, status: 0 }; },
    applyMatchReplace: null     // set below
  };

  var matchReplaceRules = [];   // { id, enabled, target, match, replace, isRegex }
  var mrIdCounter = 0;
  var fuzzerRunning = false;
  var fuzzerAbort = false;
  var storedDiffLeft = null;
  var storedDiffRight = null;
  var compareA = null;
  var compareB = null;
  var issuesBoard = [];
  var wsConn = null;
  var wsLog = [];

  // ═══════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════
  function init(hooks) {
    Object.keys(hooks || {}).forEach(function (k) {
      if (hooks[k] != null) api[k] = hooks[k];
    });
    loadMatchReplace();
    loadNotesFromStorage();
    wireUI();
  }

  // ═══════════════════════════════════════════════════
  // J: NOTES + TAGS (persisted)
  // notesMap: { [requestId]: { note: string, tags: string[] } }
  // ═══════════════════════════════════════════════════
  var notesMap = {};

  function loadNotesFromStorage() {
    try {
      chrome.storage.local.get("phantomNotes", function (data) {
        if (data && data.phantomNotes && typeof data.phantomNotes === "object") {
          notesMap = Object.create(null);
          Object.keys(data.phantomNotes).forEach(function (id) {
            if (!S.isSafeKey(id)) return;
            var n = data.phantomNotes[id];
            if (!n || typeof n !== "object") return;
            notesMap[id] = {
              note: S.clampNote(n.note || ""),
              tags: S.clampTags(n.tags || [])
            };
          });
        }
      });
    } catch (e) {}
  }

  function saveNotes() {
    // Cap total entries to avoid storage abuse
    var keys = Object.keys(notesMap);
    if (keys.length > 2000) {
      keys.slice(0, keys.length - 2000).forEach(function (k) { delete notesMap[k]; });
    }
    try {
      chrome.storage.local.set({ phantomNotes: notesMap });
    } catch (e) {}
  }

  function getNote(id) {
    return notesMap[id] || { note: "", tags: [] };
  }

  function setNote(id, note, tags) {
    if (!id || typeof id !== "string") return;
    note = S.clampNote(note);
    tags = S.clampTags(tags || []);
    if (!note && !tags.length) {
      delete notesMap[id];
    } else {
      notesMap[id] = { note: note, tags: tags };
    }
    saveNotes();
  }

  // ═══════════════════════════════════════════════════
  // A: SITEMAP
  // ═══════════════════════════════════════════════════
  function buildSitemap(requests) {
    var tree = Object.create(null); // host -> { paths: { path: { methods, count, ids } } }
    (requests || []).forEach(function (req) {
      if (!req || !req.url) return;
      var u;
      try { u = new URL(req.url); } catch (e) { return; }
      var host = u.hostname.toLowerCase();
      if (!host || !S.isSafeKey(host)) return;
      if (!tree[host]) tree[host] = { paths: Object.create(null), count: 0 };
      var path = u.pathname || "/";
      if (path.length > 512) path = path.slice(0, 512);
      tree[host].count++;
      if (!tree[host].paths[path]) {
        tree[host].paths[path] = { methods: Object.create(null), count: 0, sampleId: req.id };
      }
      var node = tree[host].paths[path];
      node.count++;
      var m = (req.method || "GET").toUpperCase();
      node.methods[m] = (node.methods[m] || 0) + 1;
      if (!node.sampleId) node.sampleId = req.id;
    });
    return tree;
  }

  function renderSitemap() {
    var root = document.getElementById("sitemap-tree");
    if (!root) return;
    root.innerHTML = "";
    var tree = buildSitemap(api.getRequests());
    var hosts = Object.keys(tree).sort();
    if (!hosts.length) {
      var empty = document.createElement("div");
      empty.className = "adv-empty";
      empty.textContent = "No traffic yet — browse a site to build the map";
      root.appendChild(empty);
      return;
    }
    hosts.forEach(function (host) {
      var hostEl = document.createElement("div");
      hostEl.className = "sitemap-host";
      var hostBtn = document.createElement("button");
      hostBtn.className = "sitemap-host-btn";
      hostBtn.type = "button";
      var hostLabel = document.createElement("span");
      hostLabel.className = "sitemap-host-name";
      hostLabel.textContent = host;
      var hostCount = document.createElement("span");
      hostCount.className = "sitemap-count";
      hostCount.textContent = String(tree[host].count);
      hostBtn.append(hostLabel, hostCount);
      var pathWrap = document.createElement("div");
      pathWrap.className = "sitemap-paths hidden";
      hostBtn.addEventListener("click", function () {
        pathWrap.classList.toggle("hidden");
        hostEl.classList.toggle("open");
      });
      var paths = Object.keys(tree[host].paths).sort();
      paths.forEach(function (path) {
        var node = tree[host].paths[path];
        var row = document.createElement("div");
        row.className = "sitemap-path-row";
        var methods = Object.keys(node.methods).sort().join(" ");
        var mSpan = document.createElement("span");
        mSpan.className = "sitemap-methods";
        mSpan.textContent = methods;
        var pSpan = document.createElement("span");
        pSpan.className = "sitemap-path";
        pSpan.textContent = path;
        pSpan.title = path;
        var cSpan = document.createElement("span");
        cSpan.className = "sitemap-count";
        cSpan.textContent = String(node.count);
        row.append(mSpan, pSpan, cSpan);
        row.addEventListener("click", function (e) {
          e.stopPropagation();
          if (node.sampleId) {
            api.switchTab("history");
            api.selectRequest(node.sampleId);
          }
        });
        row.addEventListener("contextmenu", function (e) {
          e.preventDefault();
          e.stopPropagation();
          var req = api.getRequests().find(function (r) { return r.id === node.sampleId; });
          if (!req) {
            // synthesize from host+path
            req = {
              method: Object.keys(node.methods)[0] || "GET",
              url: "https://" + host + path,
              requestHeaders: {},
              requestBody: null
            };
          }
          api.switchTab("tools");
          var nav = document.querySelector('.tools-nav-btn[data-tools="intruder"]');
          if (nav) nav.click();
          loadIntruderFromRequest(req);
          api.setStatus("Sitemap path → Intruder (mark § positions)");
        });
        pathWrap.appendChild(row);
      });
      hostEl.append(hostBtn, pathWrap);
      root.appendChild(hostEl);
    });
    var meta = document.getElementById("sitemap-meta");
    if (meta) meta.textContent = hosts.length + " host" + (hosts.length !== 1 ? "s" : "") +
      " · " + api.getRequests().length + " requests";
  }

  // ═══════════════════════════════════════════════════
  // B: GLOBAL SEARCH
  // ═══════════════════════════════════════════════════
  function runGlobalSearch() {
    var qEl = document.getElementById("search-query");
    var regexEl = document.getElementById("search-regex");
    var out = document.getElementById("search-results");
    if (!qEl || !out) return;
    var q = qEl.value;
    if (!q) {
      out.innerHTML = "";
      var e = document.createElement("div");
      e.className = "adv-empty";
      e.textContent = "Enter a search term";
      out.appendChild(e);
      return;
    }
    var compiled = S.compileUserPattern(q, !!(regexEl && regexEl.checked));
    if (!compiled.ok) {
      api.setStatus("Search error: " + compiled.error);
      return;
    }
    var fields = {
      url: document.getElementById("search-field-url"),
      headers: document.getElementById("search-field-headers"),
      body: document.getElementById("search-field-body"),
      resHeaders: document.getElementById("search-field-res-headers")
    };
    var useUrl = !fields.url || fields.url.checked;
    var useHdr = !fields.headers || fields.headers.checked;
    var useBody = !fields.body || fields.body.checked;
    var useRes = fields.resHeaders && fields.resHeaders.checked;

    var hits = [];
    var reqs = api.getRequests();
    var maxHits = 200;
    for (var i = 0; i < reqs.length && hits.length < maxHits; i++) {
      var req = reqs[i];
      var places = [];
      if (useUrl && compiled.test(req.url || "")) places.push("url");
      if (useHdr && compiled.test(JSON.stringify(req.requestHeaders || {}))) places.push("req-headers");
      if (useBody && compiled.test(req.requestBody || "")) places.push("req-body");
      if (useRes && compiled.test(JSON.stringify(req.responseHeaders || {}))) places.push("res-headers");
      if (places.length) hits.push({ req: req, places: places });
    }
    out.innerHTML = "";
    var summary = document.createElement("div");
    summary.className = "search-summary";
    summary.textContent = hits.length + " hit" + (hits.length !== 1 ? "s" : "") +
      (hits.length >= maxHits ? " (capped)" : "");
    out.appendChild(summary);
    hits.forEach(function (h) {
      var row = document.createElement("div");
      row.className = "search-hit-row";
      var m = document.createElement("span");
      m.className = "search-hit-method";
      m.textContent = h.req.method || "";
      var u = document.createElement("span");
      u.className = "search-hit-url";
      u.textContent = h.req.url || "";
      u.title = h.req.url || "";
      var p = document.createElement("span");
      p.className = "search-hit-places";
      p.textContent = h.places.join(", ");
      row.append(m, u, p);
      row.addEventListener("click", function () {
        api.switchTab("history");
        api.selectRequest(h.req.id);
      });
      out.appendChild(row);
    });
    api.setStatus("Search: " + hits.length + " results");
  }

  // ═══════════════════════════════════════════════════
  // C: RESPONSE DIFF
  // ═══════════════════════════════════════════════════
  function storeDiffSide(side) {
    // Repeater response → unified compare slots (A/B)
    var last = api.getLastResponse();
    var pack = {
      id: "rep_" + Date.now(),
      label: "REPEATER " + (last.method || "") + " " + (last.url || "").slice(0, 80) + " → " + (last.status || ""),
      method: last.method || "",
      url: last.url || "",
      headers: {},
      body: "",
      resHeaders: last.headers || {},
      status: last.status || 0,
      resBody: String(last.body || "")
    };
    if (side === "left" || side === "a") {
      compareA = pack;
      storedDiffLeft = pack;
    } else {
      compareB = pack;
      storedDiffRight = pack;
    }
    updateCompareLabels();
    api.setStatus("Compare " + ((side === "left" || side === "a") ? "A" : "B") + " set from Repeater");
  }

  function updateDiffLabels() {
    updateCompareLabels();
  }

  function lineDiff(left, right) {
    // Myers-inspired simple LCS line diff — O(n*m) with caps
    var maxLines = 2000;
    var a = String(left || "").split("\n").slice(0, maxLines);
    var b = String(right || "").split("\n").slice(0, maxLines);
    var n = a.length, m = b.length;
    // Limit product for safety
    if (n * m > 500000) {
      return [{ type: "meta", text: "Diff too large — showing truncated side-by-side" }];
    }
    var dp = [];
    for (var i = 0; i <= n; i++) {
      dp[i] = new Array(m + 1);
      dp[i][0] = i;
    }
    for (var j = 0; j <= m; j++) dp[0][j] = j;
    for (i = 1; i <= n; i++) {
      for (j = 1; j <= m; j++) {
        if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1];
        else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    var ops = [];
    i = n; j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
        ops.push({ type: "same", text: a[i - 1] });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] <= dp[i - 1][j])) {
        ops.push({ type: "add", text: b[j - 1] });
        j--;
      } else {
        ops.push({ type: "del", text: a[i - 1] });
        i--;
      }
    }
    ops.reverse();
    return ops;
  }

  function renderDiff() {
    // Unified with history compare
    runHistoryCompare();
  }

  // ═══════════════════════════════════════════════════
  // D: MATCH & REPLACE
  // ═══════════════════════════════════════════════════
  function loadMatchReplace() {
    try {
      chrome.storage.local.get("phantomMatchReplace", function (data) {
        if (data && Array.isArray(data.phantomMatchReplace)) {
          matchReplaceRules = data.phantomMatchReplace.slice(0, 50).map(function (r, idx) {
            return {
              id: r.id || (++mrIdCounter),
              enabled: !!r.enabled,
              target: ["url", "headers", "body", "cookie"].indexOf(r.target) >= 0 ? r.target : "body",
              match: String(r.match || "").slice(0, S.MAX_REGEX_LEN),
              replace: String(r.replace || "").slice(0, 4096),
              isRegex: !!r.isRegex
            };
          });
          mrIdCounter = matchReplaceRules.reduce(function (m, r) { return Math.max(m, r.id || 0); }, 0);
          renderMatchReplace();
        }
      });
    } catch (e) {}
  }

  function saveMatchReplace() {
    try {
      chrome.storage.local.set({ phantomMatchReplace: matchReplaceRules });
    } catch (e) {}
  }

  function renderMatchReplace() {
    var list = document.getElementById("mr-rules-list");
    if (!list) return;
    list.innerHTML = "";
    if (!matchReplaceRules.length) {
      var empty = document.createElement("div");
      empty.className = "adv-empty";
      empty.textContent = "No rules — add one to rewrite requests on send";
      list.appendChild(empty);
      return;
    }
    matchReplaceRules.forEach(function (rule) {
      var row = document.createElement("div");
      row.className = "mr-rule-row" + (rule.enabled ? "" : " disabled");
      var en = document.createElement("input");
      en.type = "checkbox";
      en.checked = rule.enabled;
      en.title = "Enabled";
      en.addEventListener("change", function () {
        rule.enabled = en.checked;
        saveMatchReplace();
        row.classList.toggle("disabled", !rule.enabled);
      });
      var tgt = document.createElement("span");
      tgt.className = "mr-target";
      tgt.textContent = rule.target;
      var match = document.createElement("span");
      match.className = "mr-match";
      match.textContent = (rule.isRegex ? "/" : "") + rule.match + (rule.isRegex ? "/" : "");
      match.title = rule.match;
      var arrow = document.createElement("span");
      arrow.className = "mr-arrow";
      arrow.textContent = "→";
      var rep = document.createElement("span");
      rep.className = "mr-replace";
      rep.textContent = rule.replace;
      rep.title = rule.replace;
      var del = document.createElement("button");
      del.className = "btn-del-header";
      del.textContent = "✕";
      del.addEventListener("click", function () {
        matchReplaceRules = matchReplaceRules.filter(function (r) { return r.id !== rule.id; });
        saveMatchReplace();
        renderMatchReplace();
      });
      row.append(en, tgt, match, arrow, rep, del);
      list.appendChild(row);
    });
  }

  function addMatchReplaceRule() {
    var matchEl = document.getElementById("mr-match");
    var repEl = document.getElementById("mr-replace");
    var tgtEl = document.getElementById("mr-target");
    var reEl = document.getElementById("mr-regex");
    if (!matchEl) return;
    var match = matchEl.value;
    if (!match) {
      api.setStatus("Match pattern required");
      return;
    }
    var isRegex = !!(reEl && reEl.checked);
    if (isRegex) {
      var body = match;
      var flags = "g";
      if (match.charAt(0) === "/" && match.lastIndexOf("/") > 0) {
        var last = match.lastIndexOf("/");
        body = match.slice(1, last);
        flags = match.slice(last + 1) || "g";
        if (flags.indexOf("g") < 0) flags += "g";
      }
      var chk = S.safeRegExp(body, flags);
      if (!chk.ok) {
        api.setStatus("Invalid regex: " + chk.error);
        return;
      }
    }
    if (matchReplaceRules.length >= 50) {
      api.setStatus("Max 50 match/replace rules");
      return;
    }
    matchReplaceRules.push({
      id: ++mrIdCounter,
      enabled: true,
      target: tgtEl ? tgtEl.value : "body",
      match: match.slice(0, S.MAX_REGEX_LEN),
      replace: (repEl ? repEl.value : "").slice(0, 4096),
      isRegex: isRegex
    });
    saveMatchReplace();
    renderMatchReplace();
    matchEl.value = "";
    if (repEl) repEl.value = "";
    api.setStatus("Match/replace rule added");
  }

  /**
   * Apply enabled rules to a request object (mutates a shallow copy).
   * Called before SEND_REPEATER / fuzzer.
   */
  function applyMatchReplace(req) {
    if (!req || !matchReplaceRules.length) return req;
    var out = {
      method: req.method,
      url: req.url,
      requestHeaders: Object.assign({}, req.requestHeaders || {}),
      requestBody: req.requestBody,
      cookies: req.cookies ? req.cookies.slice() : [],
      id: req.id
    };
    matchReplaceRules.forEach(function (rule) {
      if (!rule.enabled || !rule.match) return;
      function replaceIn(str) {
        if (typeof str !== "string") return str;
        if (rule.isRegex) {
          var body = rule.match;
          var flags = "g";
          if (rule.match.charAt(0) === "/" && rule.match.lastIndexOf("/") > 0) {
            var last = rule.match.lastIndexOf("/");
            body = rule.match.slice(1, last);
            flags = rule.match.slice(last + 1) || "g";
            if (flags.indexOf("g") < 0) flags += "g";
          }
          var r = S.safeRegExp(body, flags);
          if (!r.ok) return str;
          try {
            return str.replace(r.re, rule.replace);
          } catch (e) {
            return str;
          }
        }
        // Literal global replace
        if (!rule.match) return str;
        return str.split(rule.match).join(rule.replace);
      }
      if (rule.target === "url") {
        out.url = replaceIn(out.url || "");
      } else if (rule.target === "body") {
        out.requestBody = replaceIn(out.requestBody || "");
      } else if (rule.target === "headers") {
        Object.keys(out.requestHeaders).forEach(function (k) {
          if (!S.hasOwn(out.requestHeaders, k) || !S.isSafeKey(k)) return;
          out.requestHeaders[k] = replaceIn(String(out.requestHeaders[k]));
        });
      } else if (rule.target === "cookie") {
        if (out.cookies && out.cookies.length) {
          out.cookies = out.cookies.map(function (c) {
            return { name: c.name, value: replaceIn(String(c.value == null ? "" : c.value)) };
          });
        }
        Object.keys(out.requestHeaders).forEach(function (k) {
          if (k.toLowerCase() === "cookie") {
            out.requestHeaders[k] = replaceIn(String(out.requestHeaders[k]));
          }
        });
      }
    });
    return out;
  }

  // ═══════════════════════════════════════════════════
  // E: INTRUDER / FUZZER
  // Markers §…§ allowed in URL, headers, and body.
  // Results store full request + response for Burp-style inspection.
  // ═══════════════════════════════════════════════════

  var fuzzResults = [];       // { index, payload, request, response, error }
  var fuzzSelectedIdx = -1;
  var fuzzLastFocusEl = null; // last focused field for INSERT § §
  var fuzzPayloadType = "simple"; // simple | numbers | wordlist | bruteforce | null | dates | runtime
  var fuzzWordlistLines = [];     // loaded wordlist
  var fuzzRuntimeLines = [];      // runtime file lines

  /** Replace every §…§ marker with the same payload (sniper). */
  function injectPayload(str, payload) {
    if (typeof str !== "string") return str;
    var safePayload = String(payload == null ? "" : payload).replace(/§/g, "");
    return str.replace(/§[^§]*§/g, safePayload);
  }

  /** Replace §…§ markers in order with array of payloads (pitchfork/cluster). */
  function injectPayloadsOrdered(str, payloadArr) {
    if (typeof str !== "string") return str;
    var i = 0;
    return str.replace(/§[^§]*§/g, function () {
      var p = payloadArr[i] != null ? payloadArr[i] : "";
      i++;
      return String(p).replace(/§/g, "");
    });
  }

  function countMarkerSlots(url, headers, body) {
    var all = (url || "") + "\n" + (headers || "") + "\n" + (body || "");
    var m = all.match(/§[^§]*§/g);
    return m ? m.length : 0;
  }

  function getPayloadListById(id) {
    var el = document.getElementById(id);
    return S.clampPayloads(el ? el.value : "");
  }

  /**
   * Build attack iterations based on mode.
   * Returns [{ label, values: string[] }] where values[i] is payload for marker i
   */
  function buildAttackIterations() {
    var modeEl = document.getElementById("fuzz-attack-mode");
    var mode = modeEl ? modeEl.value : "sniper";
    var max = S.MAX_PAYLOADS || 500;
    var set1 = resolvePayloads();
    if (!set1.ok) return set1;

    var list1 = set1.list;
    var list2 = getPayloadListById("fuzz-payloads-2");
    var list3 = getPayloadListById("fuzz-payloads-3");
    list2 = applyPayloadProcessors(list2);
    list3 = applyPayloadProcessors(list3);

    var out = [];

    if (mode === "pitchfork") {
      var n = Math.max(list1.length, list2.length, list3.length);
      if (n > max) n = max;
      for (var i = 0; i < n; i++) {
        var v = [
          list1[i] != null ? list1[i] : (list1[list1.length - 1] || ""),
          list2[i] != null ? list2[i] : (list2[list2.length - 1] || ""),
          list3[i] != null ? list3[i] : (list3[list3.length - 1] || "")
        ];
        out.push({ label: v.filter(Boolean).join(" | ") || "(empty)", values: v });
      }
      return { ok: true, list: out, mode: mode };
    }

    if (mode === "cluster") {
      var a = list1.length ? list1 : [""];
      var b = list2.length ? list2 : [""];
      var c = list3.length ? list3 : [""];
      // Cap product
      for (var i1 = 0; i1 < a.length && out.length < max; i1++) {
        for (var i2 = 0; i2 < b.length && out.length < max; i2++) {
          for (var i3 = 0; i3 < c.length && out.length < max; i3++) {
            var vals = [a[i1], b[i2], c[i3]];
            out.push({ label: vals.join(" × "), values: vals });
          }
        }
      }
      return { ok: true, list: out, mode: mode, truncated: a.length * b.length * c.length > max };
    }

    // sniper: each payload applied to ALL markers
    list1.forEach(function (p) {
      out.push({ label: p, values: null, single: p });
    });
    return { ok: true, list: out, mode: "sniper" };
  }

  function countMarkers() {
    var url = (document.getElementById("fuzz-url") || {}).value || "";
    var headers = (document.getElementById("fuzz-headers") || {}).value || "";
    var body = (document.getElementById("fuzz-template") || {}).value || "";
    var all = url + "\n" + headers + "\n" + body;
    var m = all.match(/§[^§]*§/g);
    return m ? m.length : 0;
  }

  /**
   * Parse headers textarea "Name: value" lines into object.
   * Called after payload injection. CRLF stripped; names sanitized later.
   */
  function parseFuzzHeaders(text) {
    var h = Object.create(null);
    String(text || "").split(/\r?\n/).forEach(function (line) {
      line = line.replace(/[\r\n\0]/g, "").trim();
      if (!line || line.charAt(0) === "#") return;
      var colon = line.indexOf(":");
      if (colon <= 0) return;
      var name = line.slice(0, colon).trim().slice(0, 256);
      var val = line.slice(colon + 1).trim().slice(0, 64 * 1024);
      if (!name) return;
      // Reject prototype-pollution style names even if oddly encoded
      var check = name.replace(/§/g, "");
      if (!S.isSafeKey(check)) return;
      h[name] = val;
    });
    return h;
  }

  function headersToText(obj) {
    if (!obj) return "";
    return Object.keys(obj).map(function (k) {
      return k + ": " + obj[k];
    }).join("\n");
  }

  function buildRawRequest(req) {
    var lines = [];
    var path = "/";
    var host = "";
    try {
      var u = new URL(req.url);
      path = u.pathname + u.search;
      host = u.host;
    } catch (e) {
      path = req.url || "/";
    }
    lines.push((req.method || "GET") + " " + path + " HTTP/1.1");
    if (host) lines.push("Host: " + host);
    var hdrs = req.requestHeaders || {};
    Object.keys(hdrs).forEach(function (k) {
      if (k.toLowerCase() === "host") return;
      lines.push(k + ": " + hdrs[k]);
    });
    if (req.cookies && req.cookies.length) {
      var hasCookie = Object.keys(hdrs).some(function (k) { return k.toLowerCase() === "cookie"; });
      if (!hasCookie) {
        lines.push("Cookie: " + req.cookies.map(function (c) {
          return c.name + "=" + (c.value == null ? "" : c.value);
        }).join("; "));
      }
    }
    lines.push("");
    if (req.requestBody) lines.push(req.requestBody);
    return lines.join("\r\n");
  }

  function buildRawResponse(result) {
    if (!result) return "";
    if (!result.success) {
      return "ERROR: " + (result.error || "unknown") +
        (result.duration != null ? "\r\n\r\nTime: " + result.duration + "ms" : "");
    }
    var lines = [];
    lines.push("HTTP/1.1 " + (result.statusCode || 0) + " " + (result.statusText || ""));
    var hdrs = result.responseHeaders || {};
    Object.keys(hdrs).forEach(function (k) {
      lines.push(k + ": " + hdrs[k]);
    });
    lines.push("");
    lines.push(result.body != null ? String(result.body) : "");
    return lines.join("\r\n");
  }

  function insertPayloadMarker() {
    var el = fuzzLastFocusEl;
    if (!el || !el.classList || !el.classList.contains("fuzz-field")) {
      // Prefer currently focused, else body
      el = document.activeElement;
      if (!el || !el.classList || !el.classList.contains("fuzz-field")) {
        el = document.getElementById("fuzz-template") ||
             document.getElementById("fuzz-url") ||
             document.getElementById("fuzz-headers");
      }
    }
    if (!el || typeof el.value !== "string") {
      api.setStatus("Focus URL, Headers, or Body first, then INSERT § §");
      return;
    }
    var start = el.selectionStart != null ? el.selectionStart : el.value.length;
    var end = el.selectionEnd != null ? el.selectionEnd : start;
    var v = el.value;
    var selected = v.slice(start, end);
    el.value = v.slice(0, start) + "§" + selected + "§" + v.slice(end);
    el.focus();
    var pos = start + 1 + selected.length + 1;
    try { el.setSelectionRange(pos, pos); } catch (e) {}
    api.setStatus("Marker inserted (" + countMarkers() + " position" + (countMarkers() !== 1 ? "s" : "") + ")");
  }

  function clearFuzzResults() {
    fuzzResults = [];
    fuzzSelectedIdx = -1;
    var resultsEl = document.getElementById("fuzz-results");
    if (resultsEl) resultsEl.innerHTML = "";
    showFuzzDetail(null);
  }

  // ── Payload set generators (Burp-style) ─────────────

  function getPayloadType() {
    return fuzzPayloadType || "simple";
  }

  function setPayloadType(type) {
    fuzzPayloadType = type;
    document.querySelectorAll(".payload-type-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.ptype === type);
    });
    ["simple", "numbers", "wordlist", "bruteforce", "null", "dates", "runtime"].forEach(function (t) {
      var pan = document.getElementById("ptype-" + t);
      if (pan) pan.classList.toggle("hidden", t !== type);
    });
    updatePayloadCountLabel();
  }

  function applyPayloadProcessors(list) {
    var urlEnc = document.getElementById("fuzz-proc-url");
    var b64 = document.getElementById("fuzz-proc-b64");
    var dbl = document.getElementById("fuzz-proc-dblurl");
    var prefix = (document.getElementById("fuzz-proc-prefix") || {}).value || "";
    var suffix = (document.getElementById("fuzz-proc-suffix") || {}).value || "";
    prefix = String(prefix).slice(0, 64);
    suffix = String(suffix).slice(0, 64);
    return list.map(function (p) {
      var s = String(p == null ? "" : p);
      if (prefix) s = prefix + s;
      if (suffix) s = s + suffix;
      if (b64 && b64.checked) {
        try { s = btoa(unescape(encodeURIComponent(s))); } catch (e) { /* keep */ }
      }
      if (urlEnc && urlEnc.checked) s = encodeURIComponent(s);
      if (dbl && dbl.checked) s = encodeURIComponent(encodeURIComponent(s));
      if (s.length > 4096) s = s.slice(0, 4096);
      return s;
    });
  }

  function generateNumberPayloads() {
    var fromEl = document.getElementById("fuzz-num-from");
    var toEl = document.getElementById("fuzz-num-to");
    var stepEl = document.getElementById("fuzz-num-step");
    var baseEl = document.getElementById("fuzz-num-base");
    var padEl = document.getElementById("fuzz-num-pad");
    var from = parseInt(fromEl && fromEl.value, 10);
    var to = parseInt(toEl && toEl.value, 10);
    var step = parseInt(stepEl && stepEl.value, 10);
    var base = parseInt(baseEl && baseEl.value, 10) || 10;
    var pad = parseInt(padEl && padEl.value, 10) || 0;
    if (!isFinite(from) || !isFinite(to)) return { ok: false, error: "Invalid from/to" };
    if (!isFinite(step) || step === 0) step = 1;
    if (step < 0) step = -step;
    if (from > to) { var tmp = from; from = to; to = tmp; }
    // Hard caps: prevent runaway ranges
    var maxCount = S.MAX_PAYLOADS || 200;
    var span = Math.floor((to - from) / step) + 1;
    if (span > maxCount) {
      to = from + step * (maxCount - 1);
    }
    if (pad < 0) pad = 0;
    if (pad > 16) pad = 16;
    var out = [];
    for (var n = from; n <= to && out.length < maxCount; n += step) {
      var s;
      try {
        s = n.toString(base);
        if (base === 16) s = s.toLowerCase();
      } catch (e) {
        s = String(n);
      }
      if (pad > 0) {
        while (s.length < pad) s = "0" + s;
      }
      out.push(s);
    }
    return { ok: true, list: out, truncated: span > maxCount };
  }

  function generateBrutePayloads() {
    var preset = (document.getElementById("fuzz-brute-preset") || {}).value || "digits";
    var custom = (document.getElementById("fuzz-brute-custom") || {}).value || "";
    var minL = parseInt((document.getElementById("fuzz-brute-min") || {}).value, 10);
    var maxL = parseInt((document.getElementById("fuzz-brute-max") || {}).value, 10);
    if (!isFinite(minL) || minL < 1) minL = 1;
    if (!isFinite(maxL) || maxL < minL) maxL = minL;
    if (maxL > 4) maxL = 4;
    if (minL > 4) minL = 4;

    var charset = "";
    if (preset === "digits") charset = "0123456789";
    else if (preset === "lower") charset = "abcdefghijklmnopqrstuvwxyz";
    else if (preset === "upper") charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    else if (preset === "alpha") charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    else if (preset === "alnum") charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    else if (preset === "hex") charset = "0123456789abcdef";
    else charset = String(custom).slice(0, 64);

    // Unique chars only
    var seen = Object.create(null);
    var chars = [];
    for (var i = 0; i < charset.length; i++) {
      var ch = charset.charAt(i);
      if (seen[ch]) continue;
      seen[ch] = true;
      chars.push(ch);
    }
    if (!chars.length) return { ok: false, error: "Empty charset" };

    var maxCount = S.MAX_PAYLOADS || 200;
    // Estimate total
    var total = 0;
    for (var L = minL; L <= maxL; L++) {
      total += Math.pow(chars.length, L);
    }
    var out = [];
    function rec(prefix, depth, targetLen) {
      if (out.length >= maxCount) return;
      if (depth === targetLen) {
        out.push(prefix);
        return;
      }
      for (var c = 0; c < chars.length && out.length < maxCount; c++) {
        rec(prefix + chars[c], depth + 1, targetLen);
      }
    }
    for (var len = minL; len <= maxL && out.length < maxCount; len++) {
      rec("", 0, len);
    }
    return { ok: true, list: out, truncated: total > maxCount };
  }

  function generateDatePayloads() {
    var fromEl = document.getElementById("fuzz-date-from");
    var toEl = document.getElementById("fuzz-date-to");
    var fmtEl = document.getElementById("fuzz-date-format");
    if (!fromEl || !toEl || !fromEl.value || !toEl.value) {
      return { ok: false, error: "Set from and to dates" };
    }
    var from = new Date(fromEl.value + "T00:00:00");
    var to = new Date(toEl.value + "T00:00:00");
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return { ok: false, error: "Invalid dates" };
    }
    if (from > to) { var t = from; from = to; to = t; }
    var fmt = (fmtEl && fmtEl.value) || "YYYY-MM-DD";
    var maxCount = S.MAX_PAYLOADS || 200;
    var out = [];
    var cur = new Date(from.getTime());
    var dayMs = 86400000;
    while (cur <= to && out.length < maxCount) {
      var y = cur.getFullYear();
      var m = cur.getMonth() + 1;
      var d = cur.getDate();
      var mm = m < 10 ? "0" + m : String(m);
      var dd = d < 10 ? "0" + d : String(d);
      var s;
      if (fmt === "unix") s = String(Math.floor(cur.getTime() / 1000));
      else if (fmt === "YYYYMMDD") s = String(y) + mm + dd;
      else if (fmt === "DD/MM/YYYY") s = dd + "/" + mm + "/" + y;
      else if (fmt === "MM/DD/YYYY") s = mm + "/" + dd + "/" + y;
      else s = y + "-" + mm + "-" + dd;
      out.push(s);
      cur = new Date(cur.getTime() + dayMs);
    }
    var days = Math.floor((to - from) / dayMs) + 1;
    return { ok: true, list: out, truncated: days > maxCount };
  }

  function loadTextFileAsPayloads(file, onDone) {
    if (!file) { onDone("No file", []); return; }
    var maxBytes = 2 * 1024 * 1024; // 2MB
    if (file.size > maxBytes) {
      onDone("File too large (max 2MB)", []);
      return;
    }
    // Only allow text-ish names
    var name = String(file.name || "").toLowerCase();
    if (name && !/\.(txt|lst|dic|wordlist)$/i.test(name) && file.type && file.type.indexOf("text") < 0 && file.type !== "") {
      // still allow empty type (some OS)
    }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var text = String(reader.result || "");
        if (text.length > maxBytes) {
          onDone("File content too large", []);
          return;
        }
        // Normalize newlines, strip BOM, reject null bytes (binary)
        if (text.indexOf("\0") >= 0) {
          onDone("Binary files not allowed", []);
          return;
        }
        text = text.replace(/^\uFEFF/, "");
        var lines = text.split(/\r?\n/);
        var maxCount = S.MAX_PAYLOADS || 200;
        var out = [];
        for (var i = 0; i < lines.length && out.length < maxCount; i++) {
          // Keep empty lines as valid payloads (Burp does)
          var line = lines[i];
          if (line.length > 4096) line = line.slice(0, 4096);
          out.push(line);
        }
        onDone(null, out, lines.length > maxCount);
      } catch (e) {
        onDone(e.message || "Read failed", []);
      }
    };
    reader.onerror = function () { onDone("Failed to read file", []); };
    reader.readAsText(file);
  }

  /**
   * Resolve the active payload set into a string array (capped + processed).
   * Returns { ok, list?, error? }
   */
  function resolvePayloads() {
    var type = getPayloadType();
    var raw = [];
    var truncated = false;

    if (type === "simple") {
      var ta = document.getElementById("fuzz-payloads");
      raw = S.clampPayloads(ta ? ta.value : "");
    } else if (type === "numbers") {
      var nr = generateNumberPayloads();
      if (!nr.ok) return nr;
      raw = nr.list;
      truncated = !!nr.truncated;
    } else if (type === "wordlist") {
      raw = fuzzWordlistLines.slice(0, S.MAX_PAYLOADS || 200);
      if (!raw.length) return { ok: false, error: "Load a wordlist file first" };
    } else if (type === "runtime") {
      raw = fuzzRuntimeLines.slice(0, S.MAX_PAYLOADS || 200);
      if (!raw.length) return { ok: false, error: "Select a runtime file first" };
    } else if (type === "bruteforce") {
      var br = generateBrutePayloads();
      if (!br.ok) return br;
      raw = br.list;
      truncated = !!br.truncated;
    } else if (type === "null") {
      var cnt = parseInt((document.getElementById("fuzz-null-count") || {}).value, 10);
      if (!isFinite(cnt) || cnt < 1) cnt = 1;
      if (cnt > (S.MAX_PAYLOADS || 200)) cnt = S.MAX_PAYLOADS || 200;
      raw = [];
      for (var i = 0; i < cnt; i++) raw.push("");
    } else if (type === "dates") {
      var dr = generateDatePayloads();
      if (!dr.ok) return dr;
      raw = dr.list;
      truncated = !!dr.truncated;
    } else {
      return { ok: false, error: "Unknown payload type" };
    }

    if (!raw.length) return { ok: false, error: "No payloads generated" };
    var list = applyPayloadProcessors(raw);
    // Final cap
    if (list.length > (S.MAX_PAYLOADS || 200)) {
      list = list.slice(0, S.MAX_PAYLOADS || 200);
      truncated = true;
    }
    return { ok: true, list: list, truncated: truncated };
  }

  function updatePayloadCountLabel() {
    var el = document.getElementById("fuzz-payload-count");
    if (!el) return;
    var r = resolvePayloads();
    if (!r.ok) {
      el.textContent = "0 ready";
      el.style.color = "var(--text-dim)";
      return;
    }
    el.textContent = r.list.length + " ready" + (r.truncated ? " (capped)" : "");
    el.style.color = "var(--green)";
  }

  function previewPayloads() {
    var r = resolvePayloads();
    var prev = document.getElementById("fuzz-payload-preview");
    if (!prev) return;
    if (!r.ok) {
      prev.value = "";
      api.setStatus(r.error || "No payloads");
      updatePayloadCountLabel();
      return;
    }
    // Show up to 50 lines in preview
    var show = r.list.slice(0, 50);
    prev.value = show.join("\n") + (r.list.length > 50 ? "\n… +" + (r.list.length - 50) + " more" : "");
    updatePayloadCountLabel();
    api.setStatus(r.list.length + " payload" + (r.list.length !== 1 ? "s" : "") + " ready" +
      (r.truncated ? " (capped at " + (S.MAX_PAYLOADS || 200) + ")" : ""));
  }

  function runFuzzer() {
    if (fuzzerRunning) {
      fuzzerAbort = true;
      api.setStatus("Stopping fuzzer…");
      return;
    }
    var bodyEl = document.getElementById("fuzz-template");
    var hdrEl = document.getElementById("fuzz-headers");
    var methodEl = document.getElementById("fuzz-method");
    var urlEl = document.getElementById("fuzz-url");
    if (!urlEl) return;

    var urlTemplate = urlEl.value.trim();
    var headersTemplate = hdrEl ? hdrEl.value : "";
    var bodyTemplate = bodyEl ? bodyEl.value : "";

    var markers = countMarkers();
    if (markers === 0) {
      api.setStatus("Mark at least one position with §…§ in URL, Headers, or Body");
      return;
    }

    // Validate URL after stripping markers (use placeholder for structure check)
    var urlProbe = injectPayload(urlTemplate, "x");
    var urlErr = S.validateHttpUrl(urlProbe);
    if (urlErr && urlTemplate.indexOf("§") < 0) {
      api.setStatus("Blocked: " + urlErr);
      return;
    }

    var method = S.validateMethod(methodEl ? methodEl.value : "GET");
    if (!method) {
      api.setStatus("Invalid method");
      return;
    }
    var attack = buildAttackIterations();
    if (!attack.ok) {
      api.setStatus(attack.error || "No payloads");
      return;
    }
    var iterations = attack.list;
    previewPayloads();

    var delayMs = 150;
    var delayEl = document.getElementById("fuzz-delay");
    if (delayEl) {
      delayMs = parseInt(delayEl.value, 10);
      if (!isFinite(delayMs) || delayMs < 50) delayMs = 50;
      if (delayMs > 5000) delayMs = 5000;
    }

    var session = api.getActiveSession && api.getActiveSession();
    var baseCookies = session && session.cookies ? session.cookies.slice() : [];

    clearFuzzResults();
    fuzzerRunning = true;
    fuzzerAbort = false;
    var btn = document.getElementById("btn-fuzz-run");
    if (btn) btn.textContent = "■ STOP";

    var idx = 0;
    function next() {
      if (fuzzerAbort || idx >= iterations.length) {
        fuzzerRunning = false;
        if (btn) btn.textContent = "▶ START ATTACK";
        api.setStatus(fuzzerAbort
          ? "Fuzzer stopped at " + idx + "/" + iterations.length
          : "Fuzzer done — " + fuzzResults.length + " results · " + (attack.mode || "sniper"));
        return;
      }

      var iter = iterations[idx];
      var reqUrl, hdrText, body;
      if (iter.single != null) {
        reqUrl = injectPayload(urlTemplate, iter.single);
        hdrText = injectPayload(headersTemplate, iter.single);
        body = injectPayload(bodyTemplate, iter.single);
      } else {
        reqUrl = injectPayloadsOrdered(urlTemplate, iter.values);
        hdrText = injectPayloadsOrdered(headersTemplate, iter.values);
        body = injectPayloadsOrdered(bodyTemplate, iter.values);
      }
      var payload = iter.label;
      var headers = parseFuzzHeaders(hdrText);

      // After inject, sanitize header names strictly for wire
      var safeHeaders = Object.create(null);
      Object.keys(headers).forEach(function (k) {
        var name = S.sanitizeToken(k);
        if (!name || !S.isSafeKey(name)) return;
        safeHeaders[name] = S.sanitizeValue(String(headers[k]));
      });

      // Extract cookies from Cookie header if present
      var cookies = baseCookies.slice();
      Object.keys(safeHeaders).forEach(function (k) {
        if (k.toLowerCase() !== "cookie") return;
        String(safeHeaders[k]).split(";").forEach(function (part) {
          var eq = part.indexOf("=");
          if (eq > 0) {
            cookies.push({
              name: part.slice(0, eq).trim(),
              value: part.slice(eq + 1).trim()
            });
          }
        });
      });

      var req = applyMatchReplace({
        id: "fuzz_" + Date.now() + "_" + idx,
        method: method,
        url: reqUrl,
        requestHeaders: safeHeaders,
        requestBody: body || null,
        cookies: cookies
      });

      var urlErr2 = S.validateHttpUrl(req.url);
      if (urlErr2) {
        storeFuzzResult(idx, payload, req, null, "Blocked: " + urlErr2);
        idx++;
        setTimeout(next, delayMs);
        return;
      }

      var thisIdx = idx;
      var thisPayload = payload;
      var thisReq = {
        method: req.method,
        url: req.url,
        requestHeaders: Object.assign({}, req.requestHeaders),
        requestBody: req.requestBody,
        cookies: (req.cookies || []).slice()
      };
      idx++;

      var handler = function (ev) {
        var d = ev.detail;
        if (!d || d.id !== req.id) return;
        document.removeEventListener("phantom:fuzz-result", handler);
        storeFuzzResult(thisIdx, thisPayload, thisReq, d.result, d.result && !d.result.success ? d.result.error : null);
        setTimeout(next, delayMs);
      };
      document.addEventListener("phantom:fuzz-result", handler);

      api.sendBg({
        type: "SEND_REPEATER",
        request: {
          id: req.id,
          method: req.method,
          url: req.url,
          requestHeaders: req.requestHeaders,
          requestBody: req.requestBody,
          cookies: req.cookies
        }
      });
    }
    api.setStatus("Attacking " + iterations.length + " (" + (attack.mode || "sniper") + ") × " + markers + " pos…");
    next();
  }

  function grepFuzzResults() {
    var qEl = document.getElementById("fuzz-grep");
    var reEl = document.getElementById("fuzz-grep-regex");
    var meta = document.getElementById("fuzz-grep-meta");
    if (!qEl) return;
    var q = qEl.value;
    if (!q) {
      // clear filter
      document.querySelectorAll(".fuzz-result-row").forEach(function (r) {
        r.style.display = "";
        r.classList.remove("fuzz-grep-hit");
      });
      if (meta) meta.textContent = "";
      return;
    }
    var compiled = S.compileUserPattern(q, !!(reEl && reEl.checked));
    if (!compiled.ok) {
      api.setStatus("Grep error: " + compiled.error);
      return;
    }
    var hits = 0;
    fuzzResults.forEach(function (entry) {
      var body = (entry.response && entry.response.body) || "";
      var hdrs = JSON.stringify((entry.response && entry.response.responseHeaders) || {});
      var reqB = (entry.request && entry.request.requestBody) || "";
      var hay = body + "\n" + hdrs + "\n" + reqB + "\n" + (entry.payload || "");
      var match = compiled.test(hay);
      var row = document.querySelector('.fuzz-result-row[data-fuzz-idx="' + entry.index + '"]');
      if (row) {
        row.style.display = match ? "" : "none";
        row.classList.toggle("fuzz-grep-hit", match);
      }
      if (match) hits++;
    });
    if (meta) meta.textContent = hits + " hit" + (hits !== 1 ? "s" : "");
    api.setStatus("Grep: " + hits + " matching results");
  }

  function storeFuzzResult(i, payload, request, result, err) {
    var entry = {
      index: i,
      payload: payload,
      request: request,
      response: result || null,
      error: err || null
    };
    fuzzResults.push(entry);
    appendFuzzRow(entry);
  }

  function appendFuzzRow(entry) {
    var resultsEl = document.getElementById("fuzz-results");
    if (!resultsEl) return;
    var row = document.createElement("div");
    row.className = "fuzz-result-row";
    row.dataset.fuzzIdx = String(entry.index);
    var num = document.createElement("span");
    num.className = "fuzz-num";
    num.textContent = String(entry.index + 1);
    var pay = document.createElement("span");
    pay.className = "fuzz-payload";
    pay.textContent = entry.payload;
    pay.title = entry.payload;
    var st = document.createElement("span");
    st.className = "fuzz-status";
    var len = document.createElement("span");
    len.className = "fuzz-len";
    var dur = document.createElement("span");
    dur.className = "fuzz-dur";

    var result = entry.response;
    var err = entry.error;
    if (err || (result && !result.success)) {
      st.textContent = "ERR";
      st.style.color = "var(--red)";
      len.textContent = "—";
      dur.textContent = result && result.duration != null ? result.duration + "ms" : "—";
      row.title = String(err || (result && result.error) || "error");
    } else if (result) {
      var c = result.statusCode || 0;
      st.textContent = String(c);
      st.style.color = c >= 200 && c < 300 ? "var(--green)"
        : c >= 300 && c < 400 ? "var(--blue)"
        : c >= 400 && c < 500 ? "var(--amber)"
        : c >= 500 ? "var(--red)" : "var(--text-secondary)";
      var size = result.size != null ? result.size : String(result.body || "").length;
      len.textContent = size + "B";
      dur.textContent = (result.duration || 0) + "ms";
    } else {
      st.textContent = "—";
      len.textContent = "—";
      dur.textContent = "—";
    }

    row.append(num, pay, st, len, dur);
    row.addEventListener("click", function () {
      selectFuzzResult(entry.index);
    });
    resultsEl.appendChild(row);
  }

  function selectFuzzResult(index) {
    fuzzSelectedIdx = index;
    document.querySelectorAll(".fuzz-result-row").forEach(function (r) {
      r.classList.toggle("selected", parseInt(r.dataset.fuzzIdx, 10) === index);
    });
    var entry = null;
    for (var i = 0; i < fuzzResults.length; i++) {
      if (fuzzResults[i].index === index) { entry = fuzzResults[i]; break; }
    }
    showFuzzDetail(entry);
  }

  function showFuzzDetail(entry) {
    var reqEl = document.getElementById("fuzz-detail-req");
    var resEl = document.getElementById("fuzz-detail-res");
    var reshEl = document.getElementById("fuzz-detail-resh");
    var meta = document.getElementById("fuzz-detail-meta");
    if (!reqEl) return;

    if (!entry) {
      reqEl.textContent = "Select a result row to view the request and response";
      if (resEl) resEl.textContent = "";
      if (reshEl) reshEl.textContent = "";
      if (meta) meta.textContent = "";
      return;
    }

    reqEl.textContent = buildRawRequest(entry.request);
    if (resEl) resEl.textContent = buildRawResponse(entry.response);
    if (reshEl) {
      var lines = [];
      if (entry.response && entry.response.responseHeaders) {
        Object.keys(entry.response.responseHeaders).forEach(function (k) {
          lines.push(k + ": " + entry.response.responseHeaders[k]);
        });
      }
      if (!lines.length && entry.error) lines.push("Error: " + entry.error);
      if (!lines.length) lines.push("(no response headers)");
      reshEl.textContent = lines.join("\n");
    }
    if (meta) {
      var parts = ["#" + (entry.index + 1), "payload: " + String(entry.payload).slice(0, 40)];
      if (entry.response && entry.response.success) {
        parts.push("HTTP " + entry.response.statusCode);
        parts.push((entry.response.duration || 0) + "ms");
      } else if (entry.error) {
        parts.push("ERROR");
      }
      meta.textContent = parts.join(" · ");
    }
    // Default to request tab
    setFuzzDetailTab("req");
  }

  function setFuzzDetailTab(name) {
    document.querySelectorAll(".fuzz-dtab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.fdtab === name);
    });
    var reqEl = document.getElementById("fuzz-detail-req");
    var resEl = document.getElementById("fuzz-detail-res");
    var reshEl = document.getElementById("fuzz-detail-resh");
    if (reqEl) reqEl.classList.toggle("hidden", name !== "req");
    if (resEl) resEl.classList.toggle("hidden", name !== "res");
    if (reshEl) reshEl.classList.toggle("hidden", name !== "resh");
  }

  function getSelectedFuzzEntry() {
    if (fuzzSelectedIdx < 0) return null;
    for (var i = 0; i < fuzzResults.length; i++) {
      if (fuzzResults[i].index === fuzzSelectedIdx) return fuzzResults[i];
    }
    return null;
  }

  function sendFuzzToRepeater() {
    var entry = getSelectedFuzzEntry();
    if (!entry || !entry.request) {
      api.setStatus("Select a fuzz result first");
      return;
    }
    var r = entry.request;
    api.createSession({
      method: r.method,
      url: r.url,
      requestHeaders: r.requestHeaders || {},
      requestBody: r.requestBody || null,
      cookies: r.cookies || []
    });
    api.switchTab("repeater");
    api.setStatus("Fuzz request #" + (entry.index + 1) + " sent to Repeater");
  }

  // ═══════════════════════════════════════════════════
  // F: PARAM EXTRACTOR
  // ═══════════════════════════════════════════════════
  function extractParams(requests) {
    var map = Object.create(null); // name -> { locations: Set-like, samples, count }
    function add(name, location, sample, reqId) {
      if (!name || !S.isSafeKey(name)) return;
      name = String(name).slice(0, 128);
      if (!map[name]) map[name] = { locations: Object.create(null), samples: [], count: 0, reqIds: [] };
      var e = map[name];
      e.locations[location] = true;
      e.count++;
      if (e.samples.length < 5 && sample != null) {
        var s = String(sample).slice(0, 200);
        if (e.samples.indexOf(s) < 0) e.samples.push(s);
      }
      if (e.reqIds.length < 10 && reqId) e.reqIds.push(reqId);
    }

    (requests || []).forEach(function (req) {
      try {
        var u = new URL(req.url);
        u.searchParams.forEach(function (val, key) { add(key, "query", val, req.id); });
      } catch (e) {}
      var body = req.requestBody || "";
      if (body && body.indexOf("=") >= 0 && body.length < 100000) {
        body.split("&").forEach(function (pair) {
          var eq = pair.indexOf("=");
          if (eq > 0) {
            try {
              add(decodeURIComponent(pair.slice(0, eq)), "body", decodeURIComponent(pair.slice(eq + 1)), req.id);
            } catch (err) {
              add(pair.slice(0, eq), "body", pair.slice(eq + 1), req.id);
            }
          }
        });
      }
      if (body && body.charAt(0) === "{") {
        try {
          var j = JSON.parse(body.slice(0, 100000));
          if (j && typeof j === "object" && !Array.isArray(j)) {
            Object.keys(j).forEach(function (k) {
              if (S.isSafeKey(k)) add(k, "json", j[k], req.id);
            });
          }
        } catch (e) {}
      }
      var hdrs = req.requestHeaders || {};
      Object.keys(hdrs).forEach(function (k) {
        if (!S.hasOwn(hdrs, k)) return;
        if (k.toLowerCase() === "cookie") {
          String(hdrs[k]).split(";").forEach(function (part) {
            var eq = part.indexOf("=");
            if (eq > 0) add(part.slice(0, eq).trim(), "cookie", part.slice(eq + 1).trim(), req.id);
          });
        }
      });
    });
    return map;
  }

  function renderParams() {
    var out = document.getElementById("params-list");
    if (!out) return;
    out.innerHTML = "";
    var map = extractParams(api.getRequests());
    var names = Object.keys(map).sort();
    if (!names.length) {
      var e = document.createElement("div");
      e.className = "adv-empty";
      e.textContent = "No parameters found in history";
      out.appendChild(e);
      return;
    }
    var filterEl = document.getElementById("params-filter");
    var filter = filterEl ? filterEl.value.toLowerCase().trim() : "";
    var shown = 0;
    names.forEach(function (name) {
      var e = map[name];
      var locs = Object.keys(e.locations).join(", ");
      var samples = (e.samples || []).join(" ");
      if (filter) {
        var hay = (name + " " + locs + " " + samples).toLowerCase();
        if (hay.indexOf(filter) < 0) return;
      }
      shown++;
      var row = document.createElement("div");
      row.className = "param-row";
      var n = document.createElement("span");
      n.className = "param-name";
      n.textContent = name;
      var loc = document.createElement("span");
      loc.className = "param-loc";
      loc.textContent = locs;
      var cnt = document.createElement("span");
      cnt.className = "param-count";
      cnt.textContent = "×" + e.count;
      var sample = document.createElement("span");
      sample.className = "param-sample";
      sample.textContent = e.samples[0] || "";
      sample.title = e.samples.join(" | ");
      var send = document.createElement("button");
      send.className = "ctrl-btn small";
      send.textContent = "→ REP";
      send.title = "Open sample request in Repeater";
      send.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var id = e.reqIds[0];
        var req = api.getRequests().find(function (r) { return r.id === id; });
        if (req) {
          api.createSession(req);
          api.switchTab("repeater");
        }
      });
      row.append(n, loc, cnt, sample, send);
      out.appendChild(row);
    });
    var meta = document.getElementById("params-meta");
    if (meta) {
      meta.textContent = filter
        ? shown + " / " + names.length + " parameters"
        : names.length + " unique parameters";
    }
  }

  // ═══════════════════════════════════════════════════
  // G: WEBSOCKET CLIENT
  // ═══════════════════════════════════════════════════
  function wsLogLine(dir, text) {
    wsLog.push({ t: Date.now(), dir: dir, text: String(text).slice(0, 8192) });
    if (wsLog.length > 500) wsLog.shift();
    var log = document.getElementById("ws-log");
    if (!log) return;
    var line = document.createElement("div");
    line.className = "ws-line ws-" + dir;
    var ts = document.createElement("span");
    ts.className = "ws-ts";
    ts.textContent = new Date().toLocaleTimeString();
    var d = document.createElement("span");
    d.className = "ws-dir";
    d.textContent = dir === "in" ? "←" : dir === "out" ? "→" : "•";
    var msg = document.createElement("span");
    msg.className = "ws-msg";
    msg.textContent = text;
    line.append(ts, d, msg);
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function wsConnect() {
    var urlEl = document.getElementById("ws-url");
    if (!urlEl) return;
    var url = urlEl.value.trim();
    var err = S.validateHttpUrl(url, { websocketOnly: true });
    if (err) {
      // allow wss/ws only
      err = S.validateHttpUrl(url, { websocket: true });
      if (err || (url.indexOf("ws:") !== 0 && url.indexOf("wss:") !== 0)) {
        api.setStatus("WS blocked: " + (err || "use ws:// or wss://"));
        return;
      }
    }
    if (url.indexOf("ws:") !== 0 && url.indexOf("wss:") !== 0) {
      api.setStatus("WS URL must start with ws:// or wss://");
      return;
    }
    // Re-validate host on ws URL
    try {
      var u = new URL(url);
      if (S.isBlockedHostname(u.hostname)) {
        api.setStatus("WS blocked: private/metadata host");
        return;
      }
    } catch (e) {
      api.setStatus("Invalid WS URL");
      return;
    }
    wsDisconnect();
    try {
      wsConn = new WebSocket(url);
    } catch (e) {
      api.setStatus("WS error: " + e.message);
      return;
    }
    wsLogLine("sys", "Connecting " + url);
    wsConn.onopen = function () {
      wsLogLine("sys", "Connected");
      var st = document.getElementById("ws-status");
      if (st) { st.textContent = "CONNECTED"; st.style.color = "var(--green)"; }
      api.setStatus("WebSocket connected");
    };
    wsConn.onmessage = function (ev) {
      var data = typeof ev.data === "string" ? ev.data : "[binary " + (ev.data && ev.data.byteLength || 0) + "B]";
      wsLogLine("in", data);
    };
    wsConn.onerror = function () {
      wsLogLine("sys", "Error");
    };
    wsConn.onclose = function (ev) {
      wsLogLine("sys", "Closed (" + (ev.code || "") + ")");
      var st = document.getElementById("ws-status");
      if (st) { st.textContent = "CLOSED"; st.style.color = "var(--text-dim)"; }
      wsConn = null;
    };
  }

  function wsDisconnect() {
    if (wsConn) {
      try { wsConn.close(); } catch (e) {}
      wsConn = null;
    }
  }

  function wsSend() {
    var msgEl = document.getElementById("ws-message");
    if (!msgEl || !wsConn || wsConn.readyState !== WebSocket.OPEN) {
      api.setStatus("WS not connected");
      return;
    }
    var msg = msgEl.value;
    if (msg.length > 64 * 1024) {
      api.setStatus("Message too large (max 64KB)");
      return;
    }
    try {
      wsConn.send(msg);
      wsLogLine("out", msg);
    } catch (e) {
      api.setStatus("Send failed: " + e.message);
    }
  }

  function listWsFromHistory() {
    var list = document.getElementById("ws-history-list");
    if (!list) return;
    list.innerHTML = "";
    var wsReqs = api.getRequests().filter(function (r) {
      return r.type === "websocket" || (r.url && (r.url.indexOf("ws:") === 0 || r.url.indexOf("wss:") === 0));
    });
    if (!wsReqs.length) {
      var e = document.createElement("div");
      e.className = "adv-empty";
      e.textContent = "No WebSocket handshakes in history";
      list.appendChild(e);
      return;
    }
    wsReqs.slice(-50).reverse().forEach(function (req) {
      var row = document.createElement("div");
      row.className = "ws-hist-row";
      row.textContent = req.url;
      row.title = req.url;
      row.addEventListener("click", function () {
        var urlEl = document.getElementById("ws-url");
        if (urlEl) {
          // Convert http(s) upgrade URL to ws(s) if needed
          var u = req.url;
          if (u.indexOf("https:") === 0) u = "wss:" + u.slice(6);
          else if (u.indexOf("http:") === 0) u = "ws:" + u.slice(5);
          urlEl.value = u;
        }
      });
      list.appendChild(row);
    });
  }

  // ═══════════════════════════════════════════════════
  // H: JWT EDITOR
  // ═══════════════════════════════════════════════════
  function b64urlDecode(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return atob(s);
  }

  function b64urlEncode(str) {
    return btoa(unescape(encodeURIComponent(str)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function parseJwtParts(token) {
    token = String(token || "").trim();
    var parts = token.split(".");
    if (parts.length < 2) throw new Error("JWT needs at least header.payload");
    var header = JSON.parse(b64urlDecode(parts[0]));
    var payload = JSON.parse(b64urlDecode(parts[1]));
    var sig = parts[2] || "";
    return { header: header, payload: payload, sig: sig, parts: parts };
  }

  function jwtLoadFromInput() {
    var inp = document.getElementById("jwt-edit-input");
    var hEl = document.getElementById("jwt-edit-header");
    var pEl = document.getElementById("jwt-edit-payload");
    var sEl = document.getElementById("jwt-edit-sig");
    if (!inp) return;
    try {
      var j = parseJwtParts(inp.value);
      if (hEl) hEl.value = JSON.stringify(j.header, null, 2);
      if (pEl) pEl.value = JSON.stringify(j.payload, null, 2);
      if (sEl) sEl.value = j.sig;
      var warn = document.getElementById("jwt-edit-warning");
      if (warn) {
        var alg = (j.header && j.header.alg) || "?";
        warn.textContent = "alg: " + alg + (alg === "none" || alg === "None" ? " ⚠ alg:none — dangerous if accepted by server" : "");
        warn.classList.toggle("warn-hot", /none/i.test(String(alg)));
      }
      api.setStatus("JWT loaded into editor");
    } catch (e) {
      api.setStatus("JWT parse error: " + e.message);
    }
  }

  function jwtRebuild() {
    var hEl = document.getElementById("jwt-edit-header");
    var pEl = document.getElementById("jwt-edit-payload");
    var sEl = document.getElementById("jwt-edit-sig");
    var out = document.getElementById("jwt-edit-output");
    var secretEl = document.getElementById("jwt-edit-secret");
    if (!hEl || !pEl || !out) return;
    try {
      var header = JSON.parse(hEl.value);
      var payload = JSON.parse(pEl.value);
      if (typeof header !== "object" || header === null || Array.isArray(header)) {
        throw new Error("Header must be a JSON object");
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new Error("Payload must be a JSON object");
      }
      // Strip prototype pollution attempts
      delete header.__proto__;
      delete payload.__proto__;
      var hB = b64urlEncode(JSON.stringify(header));
      var pB = b64urlEncode(JSON.stringify(payload));
      var signingInput = hB + "." + pB;
      var alg = String(header.alg || "none");
      var sig = (sEl && sEl.value) || "";

      if (/^none$/i.test(alg)) {
        sig = "";
        out.value = signingInput + ".";
        api.setStatus("Rebuilt unsigned JWT (alg:none)");
        return;
      }

      if (secretEl && secretEl.value && /^HS/i.test(alg)) {
        // HS256 only via Web Crypto
        var secret = secretEl.value;
        if (secret.length > 1024) throw new Error("Secret too long");
        if (alg.toUpperCase() !== "HS256") {
          api.setStatus("Only HS256 re-sign supported (got " + alg + ") — keeping manual signature");
          out.value = signingInput + "." + sig;
          return;
        }
        var enc = new TextEncoder();
        crypto.subtle.importKey(
          "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
        ).then(function (key) {
          return crypto.subtle.sign("HMAC", key, enc.encode(signingInput));
        }).then(function (buf) {
          var bytes = new Uint8Array(buf);
          var bin = "";
          for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          var b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          out.value = signingInput + "." + b64;
          if (sEl) sEl.value = b64;
          api.setStatus("JWT re-signed with HS256 ✓");
        }).catch(function (e) {
          api.setStatus("Sign failed: " + e.message);
        });
        return;
      }

      out.value = signingInput + "." + sig;
      api.setStatus("JWT rebuilt (signature unchanged)");
    } catch (e) {
      api.setStatus("JWT rebuild error: " + e.message);
    }
  }

  // ═══════════════════════════════════════════════════
  // I: PROJECT SAVE / LOAD
  // ═══════════════════════════════════════════════════
  function exportProject() {
    var scope = api.getScope ? api.getScope() : null;
    var project = {
      phantomProject: true,
      version: 1,
      exportedAt: new Date().toISOString(),
      requests: (api.getRequests() || []).slice(-500).map(function (r) {
        return {
          id: r.id,
          url: r.url,
          method: r.method,
          timestamp: r.timestamp,
          tabId: r.tabId,
          type: r.type,
          status: r.status,
          statusCode: r.statusCode,
          duration: r.duration,
          requestBody: r.requestBody,
          requestHeaders: r.requestHeaders,
          responseHeaders: r.responseHeaders,
          error: r.error
        };
      }),
      bookmarks: api.getBookmarks ? api.getBookmarks() : {},
      notes: notesMap,
      scope: scope ? {
        enabled: !!scope.enabled,
        mode: scope.mode === "hide" ? "hide" : "dim",
        domains: Array.isArray(scope.domains) ? scope.domains.slice(0, 500) : []
      } : null,
      matchReplace: matchReplaceRules
    };
    var json = JSON.stringify(project);
    if (json.length > S.MAX_PROJECT_BYTES) {
      api.setStatus("Project too large to export");
      return;
    }
    var blob = new Blob([json], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "phantom-project-" + Date.now() + ".json";
    a.click();
    URL.revokeObjectURL(url);
    api.setStatus("Project exported ✓");
  }

  function importProject(file) {
    if (!file) return;
    if (file.size > S.MAX_PROJECT_BYTES) {
      api.setStatus("File too large (max " + Math.round(S.MAX_PROJECT_BYTES / 1024 / 1024) + "MB)");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var parsed = S.safeJsonParse(String(reader.result || ""), S.MAX_PROJECT_BYTES);
      if (!parsed.ok) {
        api.setStatus("Import failed: " + parsed.error);
        return;
      }
      var data = parsed.value;
      if (!data || data.phantomProject !== true) {
        api.setStatus("Not a PhantomProxy project file");
        return;
      }
      if (Array.isArray(data.requests) && api.setRequests) {
        var clean = [];
        data.requests.slice(0, 500).forEach(function (r) {
          if (!r || typeof r !== "object") return;
          if (typeof r.url !== "string" || typeof r.method !== "string") return;
          clean.push({
            id: typeof r.id === "string" ? r.id : ("imp_" + Math.random().toString(36).slice(2)),
            url: r.url.slice(0, 8192),
            method: S.validateMethod(r.method) || "GET",
            timestamp: typeof r.timestamp === "number" ? r.timestamp : Date.now(),
            tabId: typeof r.tabId === "number" ? r.tabId : -1,
            type: typeof r.type === "string" ? r.type.slice(0, 32) : "other",
            status: r.status === "error" ? "error" : "complete",
            statusCode: typeof r.statusCode === "number" ? r.statusCode : null,
            duration: typeof r.duration === "number" ? r.duration : null,
            requestBody: typeof r.requestBody === "string" ? r.requestBody.slice(0, 64 * 1024) : null,
            requestHeaders: sanitizeHeaderObj(r.requestHeaders),
            responseHeaders: sanitizeHeaderObj(r.responseHeaders),
            error: typeof r.error === "string" ? r.error.slice(0, 500) : undefined
          });
        });
        api.setRequests(clean);
      }
      if (data.notes && typeof data.notes === "object") {
        Object.keys(data.notes).forEach(function (id) {
          if (!S.isSafeKey(id)) return;
          var n = data.notes[id];
          if (n && typeof n === "object") {
            notesMap[id] = { note: S.clampNote(n.note), tags: S.clampTags(n.tags) };
          }
        });
        saveNotes();
      }
      if (data.bookmarks && typeof data.bookmarks === "object" && api.setBookmarks) {
        api.setBookmarks(data.bookmarks);
      }
      if (data.scope && api.getScope) {
        var sc = api.getScope();
        if (sc) {
          sc.enabled = !!data.scope.enabled;
          sc.mode = data.scope.mode === "hide" ? "hide" : "dim";
          if (Array.isArray(data.scope.domains)) {
            sc.domains = data.scope.domains.slice(0, 500).map(String);
          }
          try {
            chrome.storage.local.set({
              phantomScope: { enabled: sc.enabled, mode: sc.mode, domains: sc.domains }
            });
          } catch (e) {}
        }
      }
      if (Array.isArray(data.matchReplace)) {
        matchReplaceRules = data.matchReplace.slice(0, 50);
        saveMatchReplace();
        renderMatchReplace();
      }
      if (api.renderList) api.renderList();
      renderSitemap();
      renderParams();
      api.setStatus("Project imported (" + (data.requests && data.requests.length || 0) + " requests) ✓");
    };
    reader.onerror = function () { api.setStatus("Failed to read file"); };
    reader.readAsText(file);
  }

  function sanitizeHeaderObj(obj) {
    var out = Object.create(null);
    if (!obj || typeof obj !== "object") return out;
    Object.keys(obj).forEach(function (k) {
      if (!S.isSafeKey(k)) return;
      var name = S.sanitizeToken(k);
      if (!name) return;
      out[name] = S.sanitizeValue(String(obj[k]));
    });
    return out;
  }

  // ═══════════════════════════════════════════════════
  // PASSIVE ISSUE HINTS (lightweight, local only)
  // ═══════════════════════════════════════════════════
  function runPassiveChecks() {
    var out = document.getElementById("passive-results");
    if (!out) return;
    out.innerHTML = "";
    var findings = [];
    api.getRequests().forEach(function (req) {
      var rh = req.responseHeaders || {};
      var keys = Object.keys(rh).map(function (k) { return k.toLowerCase(); });
      var get = function (n) {
        for (var k in rh) {
          if (S.hasOwn(rh, k) && k.toLowerCase() === n) return rh[k];
        }
        return null;
      };
      if (req.url && req.url.indexOf("https:") === 0) {
        if (!get("strict-transport-security")) {
          findings.push({ sev: "info", title: "Missing HSTS", url: req.url, id: req.id });
        }
      }
      if (!get("x-content-type-options") && req.type === "main_frame") {
        findings.push({ sev: "low", title: "Missing X-Content-Type-Options", url: req.url, id: req.id });
      }
      if (get("access-control-allow-origin") === "*") {
        var acac = get("access-control-allow-credentials");
        if (acac && String(acac).toLowerCase() === "true") {
          findings.push({ sev: "high", title: "CORS * with credentials", url: req.url, id: req.id });
        } else {
          findings.push({ sev: "info", title: "CORS Allow-Origin: *", url: req.url, id: req.id });
        }
      }
      var loc = get("location");
      if (loc && (req.statusCode === 301 || req.statusCode === 302 || req.statusCode === 307 || req.statusCode === 308)) {
        if (/[?&](url|redirect|next|return|dest)=/i.test(req.url)) {
          findings.push({ sev: "medium", title: "Redirect with open-redirect-ish param", url: req.url, id: req.id });
        }
      }
      if (req.statusCode === 401 || req.statusCode === 403) {
        findings.push({ sev: "info", title: "Auth challenge " + req.statusCode, url: req.url, id: req.id });
      }
    });
    // Dedupe by title+host
    var seen = Object.create(null);
    var unique = [];
    findings.forEach(function (f) {
      var host = "";
      try { host = new URL(f.url).hostname; } catch (e) {}
      var key = f.title + "|" + host;
      if (seen[key]) return;
      seen[key] = true;
      unique.push(f);
    });
    unique = unique.slice(0, 100);
    if (!unique.length) {
      var e = document.createElement("div");
      e.className = "adv-empty";
      e.textContent = "No passive hints on current history";
      out.appendChild(e);
      return;
    }
    unique.forEach(function (f) {
      var row = document.createElement("div");
      row.className = "passive-row sev-" + f.sev;
      var sev = document.createElement("span");
      sev.className = "passive-sev";
      sev.textContent = f.sev.toUpperCase();
      var title = document.createElement("span");
      title.className = "passive-title";
      title.textContent = f.title;
      var url = document.createElement("span");
      url.className = "passive-url";
      url.textContent = f.url;
      url.title = f.url;
      row.append(sev, title, url);
      row.addEventListener("click", function () {
        if (f.id) {
          api.switchTab("history");
          api.selectRequest(f.id);
        }
      });
      out.appendChild(row);
    });
    api.setStatus("Passive checks: " + unique.length + " hints");
  }

  // ═══════════════════════════════════════════════════
  // UI WIRING
  // ═══════════════════════════════════════════════════
  function wireUI() {
    // Sitemap
    var btnSm = document.getElementById("btn-sitemap-refresh");
    if (btnSm) btnSm.addEventListener("click", renderSitemap);

    // Grep fuzz
    var btnGrep = document.getElementById("btn-fuzz-grep");
    if (btnGrep) btnGrep.addEventListener("click", grepFuzzResults);
    var fuzzGrep = document.getElementById("fuzz-grep");
    if (fuzzGrep) {
      fuzzGrep.addEventListener("keydown", function (e) {
        if (e.key === "Enter") grepFuzzResults();
      });
    }

    // Params → wordlist
    var btnPw = document.getElementById("btn-params-to-wordlist");
    if (btnPw) {
      btnPw.addEventListener("click", function () {
        var map = extractParams(api.getRequests());
        var lines = [];
        Object.keys(map).forEach(function (name) {
          (map[name].samples || []).forEach(function (s) {
            if (s && lines.indexOf(s) < 0) lines.push(s);
          });
          if (lines.indexOf(name) < 0) lines.push(name);
        });
        lines = lines.slice(0, S.MAX_PAYLOADS || 500);
        var ta = document.getElementById("fuzz-payloads");
        if (ta) ta.value = lines.join("\n");
        api.switchTab("tools");
        var nav = document.querySelector('.tools-nav-btn[data-tools="intruder"]');
        if (nav) nav.click();
        setPayloadType("simple");
        previewPayloads();
        api.setStatus("Exported " + lines.length + " values → Intruder wordlist");
      });
    }

    // History compare
    var btnCmp = document.getElementById("btn-compare-run");
    if (btnCmp) btnCmp.addEventListener("click", runHistoryCompare);
    var btnCmpClear = document.getElementById("btn-compare-clear");
    if (btnCmpClear) {
      btnCmpClear.addEventListener("click", function () {
        compareA = null;
        compareB = null;
        updateCompareLabels();
        var out = document.getElementById("compare-output");
        if (out) out.innerHTML = "";
      });
    }

    // Cookie jar
    var btnCj = document.getElementById("btn-cookie-jar-load");
    if (btnCj) {
      btnCj.addEventListener("click", function () {
        var url = (document.getElementById("cookie-jar-url") || {}).value || "";
        if (!url) {
          api.setStatus("Enter a URL for cookie jar");
          return;
        }
        api.sendBg({ type: "GET_COOKIES", url: url, requestId: "jar_" + Date.now() });
        // Result handled via custom event if we wire it — use chrome.cookies from panel if available
        loadCookieJarDirect(url);
      });
    }
    var btnCjCopy = document.getElementById("btn-cookie-jar-export");
    if (btnCjCopy) {
      btnCjCopy.addEventListener("click", function () {
        var list = document.getElementById("cookie-jar-list");
        if (!list) return;
        var text = list.innerText || "";
        navigator.clipboard.writeText(text).then(function () {
          api.setStatus("Cookie jar copied ✓");
        });
      });
    }

    // Issues board
    var btnIs = document.getElementById("btn-issues-scan");
    if (btnIs) btnIs.addEventListener("click", scanIssuesBoard);
    var btnIsClr = document.getElementById("btn-issues-clear");
    if (btnIsClr) {
      btnIsClr.addEventListener("click", function () {
        issuesBoard = [];
        try { chrome.storage.local.remove("phantomIssues"); } catch (e) {}
        renderIssuesBoard();
      });
    }
    loadIssuesBoard();

    // Search
    var btnSearch = document.getElementById("btn-search-run");
    if (btnSearch) btnSearch.addEventListener("click", runGlobalSearch);
    var searchQ = document.getElementById("search-query");
    if (searchQ) {
      searchQ.addEventListener("keydown", function (e) {
        if (e.key === "Enter") runGlobalSearch();
      });
    }

    // Unified compare — Repeater CMP A/B buttons
    var dA = document.getElementById("btn-diff-store-a");
    var dB = document.getElementById("btn-diff-store-b");
    if (dA) dA.addEventListener("click", function () {
      storeDiffSide("a");
      api.switchTab("tools");
      var nav = document.querySelector('.tools-nav-btn[data-tools="compare"]');
      if (nav) nav.click();
    });
    if (dB) dB.addEventListener("click", function () {
      storeDiffSide("b");
      api.switchTab("tools");
      var nav = document.querySelector('.tools-nav-btn[data-tools="compare"]');
      if (nav) nav.click();
    });

    // Match replace
    var mrAdd = document.getElementById("btn-mr-add");
    if (mrAdd) mrAdd.addEventListener("click", addMatchReplaceRule);

    // Fuzzer
    var fuzzMark = document.getElementById("btn-fuzz-marker");
    var fuzzRun = document.getElementById("btn-fuzz-run");
    var fuzzClear = document.getElementById("btn-fuzz-clear-results");
    if (fuzzMark) fuzzMark.addEventListener("click", insertPayloadMarker);
    if (fuzzRun) fuzzRun.addEventListener("click", runFuzzer);
    if (fuzzClear) fuzzClear.addEventListener("click", clearFuzzResults);

    // Payload type tabs
    document.querySelectorAll(".payload-type-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setPayloadType(btn.dataset.ptype);
      });
    });

    // Numbers generate
    var genNum = document.getElementById("btn-fuzz-gen-numbers");
    if (genNum) genNum.addEventListener("click", function () {
      setPayloadType("numbers");
      previewPayloads();
    });
    var genBrute = document.getElementById("btn-fuzz-gen-brute");
    if (genBrute) genBrute.addEventListener("click", function () {
      setPayloadType("bruteforce");
      previewPayloads();
    });
    var genDates = document.getElementById("btn-fuzz-gen-dates");
    if (genDates) genDates.addEventListener("click", function () {
      setPayloadType("dates");
      previewPayloads();
    });
    var prevBtn = document.getElementById("btn-fuzz-preview-payloads");
    if (prevBtn) prevBtn.addEventListener("click", previewPayloads);

    // Brute charset preset → enable custom
    var brutePreset = document.getElementById("fuzz-brute-preset");
    var bruteCustom = document.getElementById("fuzz-brute-custom");
    if (brutePreset && bruteCustom) {
      brutePreset.addEventListener("change", function () {
        bruteCustom.disabled = brutePreset.value !== "custom";
        if (brutePreset.value !== "custom") bruteCustom.value = "";
      });
    }

    // Wordlist file
    var wlBtn = document.getElementById("btn-fuzz-wordlist");
    var wlInput = document.getElementById("fuzz-wordlist-input");
    var wlName = document.getElementById("fuzz-wordlist-name");
    var wlPrev = document.getElementById("fuzz-wordlist-preview");
    if (wlBtn && wlInput) {
      wlBtn.addEventListener("click", function () { wlInput.click(); });
      wlInput.addEventListener("change", function () {
        var f = wlInput.files && wlInput.files[0];
        if (!f) return;
        loadTextFileAsPayloads(f, function (err, lines, truncated) {
          if (err) {
            fuzzWordlistLines = [];
            if (wlName) wlName.textContent = "Error: " + err;
            if (wlPrev) wlPrev.value = "";
            api.setStatus("Wordlist: " + err);
            updatePayloadCountLabel();
            return;
          }
          fuzzWordlistLines = lines;
          if (wlName) {
            wlName.textContent = f.name + " · " + lines.length + " line" +
              (lines.length !== 1 ? "s" : "") + (truncated ? " (capped)" : "");
          }
          if (wlPrev) wlPrev.value = lines.slice(0, 100).join("\n") +
            (lines.length > 100 ? "\n… +" + (lines.length - 100) + " more" : "");
          setPayloadType("wordlist");
          previewPayloads();
          api.setStatus("Wordlist loaded: " + lines.length + " payloads" +
            (truncated ? " (capped at " + (S.MAX_PAYLOADS || 200) + ")" : ""));
        });
        wlInput.value = "";
      });
    }

    // Runtime file (same loader, separate state)
    var rtBtn = document.getElementById("btn-fuzz-runtime");
    var rtInput = document.getElementById("fuzz-runtime-input");
    var rtName = document.getElementById("fuzz-runtime-name");
    var rtPrev = document.getElementById("fuzz-runtime-preview");
    if (rtBtn && rtInput) {
      rtBtn.addEventListener("click", function () { rtInput.click(); });
      rtInput.addEventListener("change", function () {
        var f = rtInput.files && rtInput.files[0];
        if (!f) return;
        loadTextFileAsPayloads(f, function (err, lines, truncated) {
          if (err) {
            fuzzRuntimeLines = [];
            if (rtName) rtName.textContent = "Error: " + err;
            if (rtPrev) rtPrev.value = "";
            api.setStatus("Runtime file: " + err);
            updatePayloadCountLabel();
            return;
          }
          fuzzRuntimeLines = lines;
          if (rtName) {
            rtName.textContent = f.name + " · " + lines.length + " line" +
              (lines.length !== 1 ? "s" : "") + (truncated ? " (capped)" : "");
          }
          if (rtPrev) rtPrev.value = lines.slice(0, 100).join("\n") +
            (lines.length > 100 ? "\n… +" + (lines.length - 100) + " more" : "");
          setPayloadType("runtime");
          previewPayloads();
          api.setStatus("Runtime file ready: " + lines.length + " payloads");
        });
        rtInput.value = "";
      });
    }

    // Live count when simple list edits
    var simpleTa = document.getElementById("fuzz-payloads");
    if (simpleTa) {
      simpleTa.addEventListener("input", function () {
        if (getPayloadType() === "simple") updatePayloadCountLabel();
      });
    }
    // Processor toggles refresh count
    ["fuzz-proc-url", "fuzz-proc-b64", "fuzz-proc-dblurl", "fuzz-proc-prefix", "fuzz-proc-suffix",
     "fuzz-null-count", "fuzz-num-from", "fuzz-num-to", "fuzz-num-step"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("change", updatePayloadCountLabel);
      if (el) el.addEventListener("input", updatePayloadCountLabel);
    });

    // Track last focused fuzz field for INSERT § §
    document.querySelectorAll(".fuzz-field").forEach(function (el) {
      el.addEventListener("focus", function () { fuzzLastFocusEl = el; });
    });

    // Init payload type UI
    setPayloadType("simple");

    // Detail tabs
    document.querySelectorAll(".fuzz-dtab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setFuzzDetailTab(btn.dataset.fdtab);
      });
    });

    var fuzzToRep = document.getElementById("btn-fuzz-to-repeater");
    if (fuzzToRep) fuzzToRep.addEventListener("click", sendFuzzToRepeater);

    var fuzzCopyReq = document.getElementById("btn-fuzz-copy-req");
    if (fuzzCopyReq) {
      fuzzCopyReq.addEventListener("click", function () {
        var entry = getSelectedFuzzEntry();
        if (!entry) { api.setStatus("Select a result first"); return; }
        navigator.clipboard.writeText(buildRawRequest(entry.request)).then(function () {
          api.setStatus("Request copied ✓");
        });
      });
    }
    var fuzzCopyRes = document.getElementById("btn-fuzz-copy-res");
    if (fuzzCopyRes) {
      fuzzCopyRes.addEventListener("click", function () {
        var entry = getSelectedFuzzEntry();
        if (!entry) { api.setStatus("Select a result first"); return; }
        navigator.clipboard.writeText(buildRawResponse(entry.response)).then(function () {
          api.setStatus("Response copied ✓");
        });
      });
    }

    // Params
    var btnParams = document.getElementById("btn-params-refresh");
    if (btnParams) btnParams.addEventListener("click", renderParams);
    var pf = document.getElementById("params-filter");
    if (pf) pf.addEventListener("input", function () { renderParams(); });

    // WS
    var wsC = document.getElementById("btn-ws-connect");
    var wsD = document.getElementById("btn-ws-disconnect");
    var wsS = document.getElementById("btn-ws-send");
    var wsR = document.getElementById("btn-ws-refresh-hist");
    if (wsC) wsC.addEventListener("click", wsConnect);
    if (wsD) wsD.addEventListener("click", wsDisconnect);
    if (wsS) wsS.addEventListener("click", wsSend);
    if (wsR) wsR.addEventListener("click", listWsFromHistory);

    // JWT
    var jwtLoad = document.getElementById("btn-jwt-load");
    var jwtBuild = document.getElementById("btn-jwt-rebuild");
    var jwtCopy = document.getElementById("btn-jwt-copy");
    if (jwtLoad) jwtLoad.addEventListener("click", jwtLoadFromInput);
    if (jwtBuild) jwtBuild.addEventListener("click", jwtRebuild);
    if (jwtCopy) {
      jwtCopy.addEventListener("click", function () {
        var out = document.getElementById("jwt-edit-output");
        if (out && out.value) {
          navigator.clipboard.writeText(out.value).then(function () {
            api.setStatus("JWT copied ✓");
          });
        }
      });
    }

    // Project
    var exp = document.getElementById("btn-project-export");
    var imp = document.getElementById("btn-project-import");
    var impInput = document.getElementById("project-import-input");
    if (exp) exp.addEventListener("click", exportProject);
    if (imp && impInput) {
      imp.addEventListener("click", function () { impInput.click(); });
      impInput.addEventListener("change", function () {
        var f = impInput.files && impInput.files[0];
        if (f) importProject(f);
        impInput.value = "";
      });
    }

    // Topbar project buttons (if present)
    var exp2 = document.getElementById("btn-export-project");
    var imp2 = document.getElementById("btn-import-project");
    if (exp2) exp2.addEventListener("click", exportProject);
    if (imp2 && impInput) imp2.addEventListener("click", function () { impInput.click(); });

    // Passive
    var pas = document.getElementById("btn-passive-run");
    if (pas) pas.addEventListener("click", runPassiveChecks);

    // Tools sub-nav
    document.querySelectorAll(".tools-nav-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll(".tools-nav-btn").forEach(function (b) { b.classList.remove("active"); });
        document.querySelectorAll(".tools-pane").forEach(function (p) { p.classList.add("hidden"); });
        btn.classList.add("active");
        var pane = document.getElementById("tools-" + btn.dataset.tools);
        if (pane) pane.classList.remove("hidden");
        // Auto-refresh some panes
        if (btn.dataset.tools === "sitemap") renderSitemap();
        if (btn.dataset.tools === "params") renderParams();
        if (btn.dataset.tools === "websocket") listWsFromHistory();
      });
    });

    // Notes UI on detail (if fields exist)
    var noteSave = document.getElementById("btn-note-save");
    if (noteSave) {
      noteSave.addEventListener("click", function () {
        var idEl = document.getElementById("note-request-id");
        var noteEl = document.getElementById("note-text");
        var tagsEl = document.getElementById("note-tags");
        if (!idEl || !idEl.value) {
          api.setStatus("Select a request first");
          return;
        }
        var tags = tagsEl ? tagsEl.value.split(",").map(function (t) { return t.trim(); }) : [];
        setNote(idEl.value, noteEl ? noteEl.value : "", tags);
        api.setStatus("Note saved ✓");
        if (api.renderList) api.renderList();
      });
    }
  }

  function fillNoteEditor(requestId) {
    var idEl = document.getElementById("note-request-id");
    var noteEl = document.getElementById("note-text");
    var tagsEl = document.getElementById("note-tags");
    if (idEl) idEl.value = requestId || "";
    var n = getNote(requestId);
    if (noteEl) noteEl.value = n.note || "";
    if (tagsEl) tagsEl.value = (n.tags || []).join(", ");
  }

  function onTabActivated(name) {
    if (name === "tools") {
      var active = document.querySelector(".tools-nav-btn.active");
      if (active && active.dataset.tools === "sitemap") renderSitemap();
    }
  }

  // Fuzzer result bridge — panel.js dispatches when id starts with fuzz_
  function handleFuzzResponse(id, result) {
    document.dispatchEvent(new CustomEvent("phantom:fuzz-result", {
      detail: { id: id, result: result }
    }));
  }

  /**
   * Populate Intruder positions from a captured / repeater request.
   */
  function loadIntruderFromRequest(req) {
    if (!req) return;
    var methodEl = document.getElementById("fuzz-method");
    var urlEl = document.getElementById("fuzz-url");
    var hdrEl = document.getElementById("fuzz-headers");
    var bodyEl = document.getElementById("fuzz-template");
    if (methodEl) methodEl.value = req.method || "GET";
    if (urlEl) urlEl.value = req.url || "";
    if (hdrEl) {
      var h = req.requestHeaders || {};
      var lines = [];
      Object.keys(h).forEach(function (k) {
        if (k.toLowerCase() === "host" || k.toLowerCase() === "content-length") return;
        lines.push(k + ": " + h[k]);
      });
      hdrEl.value = lines.join("\n");
    }
    if (bodyEl) bodyEl.value = req.requestBody || "";
    api.setStatus("Loaded into Intruder — select text in URL/Headers/Body and click INSERT § §");
  }

  // ── History comparer ──
  function setCompareSide(side, req) {
    if (!req) return;
    var pack = {
      id: req.id,
      label: "HISTORY " + (req.method || "") + " " + (req.url || "").slice(0, 100),
      method: req.method,
      url: req.url,
      headers: req.requestHeaders || {},
      body: req.requestBody || "",
      resHeaders: req.responseHeaders || {},
      status: req.statusCode,
      resBody: ""
    };
    if (side === "a" || side === "left") compareA = pack;
    else compareB = pack;
    updateCompareLabels();
    api.setStatus("Compare " + String(side).toUpperCase() + " set from History");
  }

  function updateCompareLabels() {
    var a = document.getElementById("compare-label-a");
    var b = document.getElementById("compare-label-b");
    if (a) a.textContent = compareA ? compareA.label : "(empty — History CMP A or Repeater CMP A)";
    if (b) b.textContent = compareB ? compareB.label : "(empty — History CMP B or Repeater CMP B)";
  }

  function runHistoryCompare() {
    var out = document.getElementById("compare-output");
    if (!out) return;
    out.innerHTML = "";
    if (!compareA || !compareB) {
      var e = document.createElement("div");
      e.className = "adv-empty";
      e.textContent = "Set A and B from History (CMP A/B) or Repeater response bar (CMP A/B), then COMPARE";
      out.appendChild(e);
      return;
    }
    function block(title, left, right) {
      var h = document.createElement("div");
      h.className = "diff-meta";
      h.textContent = title;
      out.appendChild(h);
      lineDiff(String(left || ""), String(right || "")).forEach(function (op) {
        var line = document.createElement("div");
        line.className = "diff-line diff-" + op.type;
        var prefix = op.type === "add" ? "+" : op.type === "del" ? "-" : " ";
        line.textContent = prefix + " " + op.text;
        out.appendChild(line);
      });
    }
    block("URL / status",
      compareA.method + " " + compareA.url + " → " + compareA.status,
      compareB.method + " " + compareB.url + " → " + compareB.status);
    block("Request headers",
      JSON.stringify(compareA.headers || {}, null, 2),
      JSON.stringify(compareB.headers || {}, null, 2));
    block("Request body", compareA.body || "(empty)", compareB.body || "(empty)");
    block("Response headers",
      JSON.stringify(compareA.resHeaders || {}, null, 2),
      JSON.stringify(compareB.resHeaders || {}, null, 2));
    if (compareA.resBody || compareB.resBody) {
      block("Response body", compareA.resBody || "(empty)", compareB.resBody || "(empty)");
    }
    api.setStatus("Compare complete");
  }

  // ── Cookie jar ──
  function loadCookieJarDirect(url) {
    if (!chrome.cookies || !chrome.cookies.getAll) {
      api.setStatus("cookies API unavailable");
      return;
    }
    try {
      chrome.cookies.getAll({ url: url }, function (list) {
        var el = document.getElementById("cookie-jar-list");
        if (!el) return;
        el.innerHTML = "";
        if (chrome.runtime.lastError || !list || !list.length) {
          var empty = document.createElement("div");
          empty.className = "adv-empty";
          empty.textContent = "No cookies for this URL";
          el.appendChild(empty);
          return;
        }
        list.forEach(function (c) {
          var row = document.createElement("div");
          row.className = "param-row";
          var n = document.createElement("span");
          n.className = "param-name";
          n.textContent = c.name;
          var d = document.createElement("span");
          d.className = "param-loc";
          d.textContent = c.domain || "";
          var v = document.createElement("span");
          v.className = "param-sample";
          v.textContent = c.value || "";
          v.title = c.value || "";
          var p = document.createElement("span");
          p.className = "param-count";
          p.textContent = c.path || "/";
          row.append(n, d, p, v);
          el.appendChild(row);
        });
        api.setStatus("Loaded " + list.length + " cookies");
      });
    } catch (e) {
      api.setStatus("Cookie jar error: " + e.message);
    }
  }

  // ── Issues board ──
  function loadIssuesBoard() {
    try {
      chrome.storage.local.get("phantomIssues", function (data) {
        if (data && Array.isArray(data.phantomIssues)) {
          issuesBoard = data.phantomIssues.slice(0, 200);
          renderIssuesBoard();
        }
      });
    } catch (e) {}
  }

  function saveIssuesBoard() {
    try { chrome.storage.local.set({ phantomIssues: issuesBoard.slice(0, 200) }); } catch (e) {}
  }

  function scanIssuesBoard() {
    // Reuse passive check logic by scanning requests
    var findings = [];
    api.getRequests().forEach(function (req) {
      var rh = req.responseHeaders || {};
      function get(n) {
        for (var k in rh) {
          if (S.hasOwn(rh, k) && k.toLowerCase() === n) return rh[k];
        }
        return null;
      }
      if (req.url && req.url.indexOf("https:") === 0 && !get("strict-transport-security")) {
        findings.push({ sev: "info", title: "Missing HSTS", url: req.url, id: req.id, ts: Date.now() });
      }
      if (get("access-control-allow-origin") === "*") {
        var acac = get("access-control-allow-credentials");
        findings.push({
          sev: acac && String(acac).toLowerCase() === "true" ? "high" : "info",
          title: acac && String(acac).toLowerCase() === "true" ? "CORS * + credentials" : "CORS *",
          url: req.url,
          id: req.id,
          ts: Date.now()
        });
      }
      if (req.statusCode === 401 || req.statusCode === 403) {
        findings.push({ sev: "info", title: "Auth " + req.statusCode, url: req.url, id: req.id, ts: Date.now() });
      }
      if (req.statusCode >= 500) {
        findings.push({ sev: "medium", title: "Server error " + req.statusCode, url: req.url, id: req.id, ts: Date.now() });
      }
      var u = (req.url || "").toLowerCase();
      if (u.indexOf("/admin") >= 0 || u.indexOf("/.env") >= 0) {
        findings.push({ sev: "medium", title: "Sensitive path", url: req.url, id: req.id, ts: Date.now() });
      }
    });
    // Dedupe merge into board
    var seen = Object.create(null);
    issuesBoard.forEach(function (f) { seen[f.title + "|" + f.url] = true; });
    findings.forEach(function (f) {
      var key = f.title + "|" + f.url;
      if (seen[key]) return;
      seen[key] = true;
      issuesBoard.push(f);
    });
    issuesBoard = issuesBoard.slice(-200);
    saveIssuesBoard();
    renderIssuesBoard();
    api.setStatus("Issue board: " + issuesBoard.length + " items");
  }

  function renderIssuesBoard() {
    var out = document.getElementById("issues-list");
    if (!out) return;
    out.innerHTML = "";
    if (!issuesBoard.length) {
      var e = document.createElement("div");
      e.className = "adv-empty";
      e.textContent = "No issues yet — run SCAN HISTORY";
      out.appendChild(e);
      return;
    }
    issuesBoard.slice().reverse().forEach(function (f) {
      var row = document.createElement("div");
      row.className = "passive-row sev-" + (f.sev || "info");
      var sev = document.createElement("span");
      sev.className = "passive-sev";
      sev.textContent = (f.sev || "info").toUpperCase();
      var title = document.createElement("span");
      title.className = "passive-title";
      title.textContent = f.title;
      var url = document.createElement("span");
      url.className = "passive-url";
      url.textContent = f.url;
      url.title = f.url;
      row.append(sev, title, url);
      row.addEventListener("click", function () {
        if (f.id) {
          api.switchTab("history");
          api.selectRequest(f.id);
        }
      });
      out.appendChild(row);
    });
  }

  return {
    init: init,
    applyMatchReplace: applyMatchReplace,
    getNote: getNote,
    setNote: setNote,
    fillNoteEditor: fillNoteEditor,
    notesMap: function () { return notesMap; },
    onTabActivated: onTabActivated,
    handleFuzzResponse: handleFuzzResponse,
    loadIntruderFromRequest: loadIntruderFromRequest,
    setCompareSide: setCompareSide,
    renderSitemap: renderSitemap,
    storeDiffSide: storeDiffSide,
    exportProject: exportProject
  };
})();

window.PhantomAdvanced = PhantomAdvanced;
