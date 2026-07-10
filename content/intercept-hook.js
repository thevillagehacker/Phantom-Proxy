// PhantomProxy — MAIN-world fetch/XHR intercept hook v2.3.0
// Pauses page requests until bridge posts a decision.
// Preserves original body types (string, URLSearchParams, FormData, Blob) on pure forward.
"use strict";

(function () {
  if (window.__phantomIxHook) return;
  window.__phantomIxHook = true;

  var enabled = false;
  var pending = Object.create(null);
  var bodyStore = Object.create(null); // id -> original body (any type)
  var seq = 0;
  var TIMEOUT_MS = 120000;

  function uid() {
    return "pg_" + Date.now() + "_" + (++seq);
  }

  function waitDecision(id) {
    return new Promise(function (resolve) {
      pending[id] = resolve;
      setTimeout(function () {
        if (pending[id]) {
          // Timeout: auto-forward with original body
          pending[id]({ action: "forward", pure: true });
          delete pending[id];
        }
      }, TIMEOUT_MS);
    });
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== "phantom-ix-bridge") return;
    if (d.type === "enable") {
      enabled = !!d.enabled;
      return;
    }
    if (d.type === "decision" && d.id && pending[d.id]) {
      pending[d.id](d);
      delete pending[d.id];
    }
  });

  function headersToObject(h) {
    var out = Object.create(null);
    if (!h) return out;
    if (typeof Headers !== "undefined" && h instanceof Headers) {
      h.forEach(function (v, k) { out[k] = v; });
      return out;
    }
    if (Array.isArray(h)) {
      h.forEach(function (pair) {
        if (pair && pair[0]) out[pair[0]] = pair[1];
      });
      return out;
    }
    if (typeof h === "object") {
      Object.keys(h).forEach(function (k) {
        if (k === "__proto__" || k === "constructor") return;
        out[k] = h[k];
      });
    }
    return out;
  }

  /** Best-effort string preview for the intercept UI (never used for pure forward). */
  function bodyPreview(body) {
    if (body == null) return null;
    if (typeof body === "string") return body.slice(0, 65536);
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      return body.toString().slice(0, 65536);
    }
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      try {
        var parts = [];
        body.forEach(function (v, k) {
          parts.push(k + "=" + (typeof v === "string" ? v : "[blob]"));
        });
        return parts.join("&").slice(0, 65536);
      } catch (e) {
        return "[FormData]";
      }
    }
    if (typeof Blob !== "undefined" && body instanceof Blob) {
      return "[Blob " + (body.type || "binary") + " " + body.size + "B]";
    }
    if (body instanceof ArrayBuffer || (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(body))) {
      return "[Binary " + (body.byteLength || body.length || 0) + "B]";
    }
    try {
      return String(body).slice(0, 65536);
    } catch (e) {
      return "[unprintable body]";
    }
  }

  function methodAllowsBody(method) {
    var m = String(method || "GET").toUpperCase();
    return m !== "GET" && m !== "HEAD" && m !== "TRACE";
  }

  // ── fetch ──
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    if (!enabled) return _fetch.apply(this, arguments);

    // Normalize Request object + init
    var reqObj = null;
    if (typeof Request !== "undefined" && input instanceof Request) {
      reqObj = input;
    }
    init = init ? Object.assign({}, init) : {};

    var url = reqObj ? reqObj.url : (typeof input === "string" ? input : String(input));
    var method = (init.method || (reqObj && reqObj.method) || "GET").toUpperCase();
    var headers = headersToObject(init.headers || (reqObj && reqObj.headers));

    // Body: prefer init.body, else clone from Request (async path)
    var bodyRaw = init.body !== undefined ? init.body : null;
    var id = uid();

    function pauseAndSend(preview, rawBody) {
      bodyStore[id] = rawBody;
      try { url = new URL(url, location.href).href; } catch (e) {}

      window.postMessage({
        source: "phantom-ix-hook",
        id: id,
        method: method,
        url: url,
        headers: headers,
        body: preview,
        resourceType: "fetch"
      }, "*");

      return waitDecision(id).then(function (d) {
        var orig = bodyStore[id];
        delete bodyStore[id];

        if (!d || d.action === "drop") {
          return Promise.reject(new TypeError("Failed to fetch (PhantomProxy intercept DROP)"));
        }

        // Pure forward: call original fetch with original arguments unchanged
        if (d.pure || (d.body === undefined && !d.headers && !d.url && !d.method)) {
          return _fetch.apply(window, [input, init]);
        }

        var opts = Object.assign({}, init);
        var finalMethod = (d.method || method || "GET").toUpperCase();
        opts.method = finalMethod;

        if (d.headers && typeof d.headers === "object") {
          opts.headers = d.headers;
        }

        if (d.body !== undefined && d.body !== null && methodAllowsBody(finalMethod)) {
          opts.body = d.body;
        } else if (methodAllowsBody(finalMethod)) {
          // Keep original body type (FormData, Blob, string, …)
          if (orig !== undefined && orig !== null) opts.body = orig;
          else if (init.body !== undefined) opts.body = init.body;
        } else {
          // GET/HEAD must not carry a body
          delete opts.body;
        }

        var finalUrl = d.url || url;
        return _fetch.call(window, finalUrl, opts);
      });
    }

    // Request object may need async text() for body preview
    if (bodyRaw == null && reqObj && methodAllowsBody(method)) {
      // Don't consume the body of the original Request if we pure-forward —
      // store a clone for modified path
      try {
        var cloned = reqObj.clone();
        return cloned.text().then(function (text) {
          return pauseAndSend(text.slice(0, 65536), text);
        }).catch(function () {
          return pauseAndSend(null, null);
        });
      } catch (e) {
        return pauseAndSend(null, null);
      }
    }

    return pauseAndSend(bodyPreview(bodyRaw), bodyRaw);
  };

  // ── XHR ──
  var XO = XMLHttpRequest.prototype.open;
  var XS = XMLHttpRequest.prototype.send;
  var XH = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
    this.__pxMethod = method;
    this.__pxUrl = url;
    this.__pxHeaders = Object.create(null);
    this.__pxOpenArgs = arguments;
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (!this.__pxHeaders) this.__pxHeaders = Object.create(null);
    this.__pxHeaders[k] = v;
    return XH.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    if (!enabled) return XS.apply(this, arguments);

    var url = xhr.__pxUrl || "";
    try { url = new URL(url, location.href).href; } catch (e) {}
    var method = (xhr.__pxMethod || "GET").toUpperCase();
    var headers = xhr.__pxHeaders || {};
    var id = uid();
    bodyStore[id] = body;

    window.postMessage({
      source: "phantom-ix-hook",
      id: id,
      method: method,
      url: url,
      headers: headers,
      body: bodyPreview(body),
      resourceType: "xhr"
    }, "*");

    waitDecision(id).then(function (d) {
      var orig = bodyStore[id];
      delete bodyStore[id];

      if (!d || d.action === "drop") {
        try {
          xhr.dispatchEvent(new Event("error"));
          xhr.dispatchEvent(new Event("loadend"));
        } catch (e) {}
        return;
      }

      // Pure forward
      if (d.pure || (d.body === undefined && !d.headers)) {
        XS.call(xhr, orig);
        return;
      }

      if (d.headers && typeof d.headers === "object") {
        Object.keys(d.headers).forEach(function (k) {
          try { XH.call(xhr, k, d.headers[k]); } catch (e) {}
        });
      }

      var finalMethod = (d.method || method || "GET").toUpperCase();
      var b;
      if (d.body !== undefined && d.body !== null && methodAllowsBody(finalMethod)) {
        b = d.body;
      } else if (methodAllowsBody(finalMethod)) {
        b = orig;
      } else {
        b = null;
      }
      XS.call(xhr, b);
    });
  };

  window.postMessage({ source: "phantom-ix-hook", type: "ready" }, "*");
})();
