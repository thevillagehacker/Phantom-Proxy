(function () {
  "use strict";

  var TOKEN_FIELDS = {
    "csrf": true,
    "csrfmiddlewaretoken": true,
    "csrf_token": true,
    "_csrf": true,
    "xsrf": true,
    "xsrf_token": true,
    "authenticity_token": true,
    "__requestverificationtoken": true,
    "_token": true
  };

  var BROWSER_CONTROLLED = {
    "host": true,
    "origin": true,
    "referer": true,
    "content-length": true,
    "connection": true,
    "transfer-encoding": true,
    "accept-encoding": true
  };

  var SUMMARY = {
    "bad-url": "Blocked. URL must be http or https.",
    "method": "Blocked. A form can only send GET or POST.",
    "get-with-body": "Blocked. GET has a body a form cannot send.",
    "content-type": "Blocked. A form cannot send this content type.",
    "file-field": "Blocked. A form cannot resend a file part.",
    "unparsed-body": "Blocked. The body did not parse as form fields.",
    "form": "Form proof. Headers are not in the page."
  };

  function formPlan(html, enctype, dropped, tokenFields) {
    return {
      kind: "form",
      html: html,
      enctype: enctype,
      reason: null,
      summary: SUMMARY.form,
      dropped: dropped,
      tokenFields: tokenFields
    };
  }

  function blockedPlan(reason, dropped, tokenFields) {
    return {
      kind: "blocked",
      html: null,
      enctype: null,
      reason: reason,
      summary: SUMMARY[reason],
      dropped: dropped || [],
      tokenFields: tokenFields || []
    };
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function headerEntries(headers) {
    var out = [];
    if (!headers || typeof headers !== "object") return out;
    Object.keys(headers).forEach(function (name) {
      if (!Object.prototype.hasOwnProperty.call(headers, name)) return;
      out.push(name);
    });
    return out;
  }

  function headerValue(headers, wanted) {
    var names = headerEntries(headers);
    var lower = wanted.toLowerCase();
    for (var i = 0; i < names.length; i++) {
      if (names[i].toLowerCase() === lower) {
        var value = headers[names[i]];
        return value == null ? "" : String(value);
      }
    }
    return "";
  }

  function mediaType(raw) {
    if (!raw) return "";
    var semi = raw.indexOf(";");
    var media = semi < 0 ? raw : raw.slice(0, semi);
    return media.trim().toLowerCase();
  }

  function classifyDropped(headers, honorContentType) {
    var dropped = [];
    headerEntries(headers).forEach(function (name) {
      var lower = name.toLowerCase();
      if (lower === "content-type" && honorContentType) return;
      var reason = "not-form-settable";
      if (lower === "cookie") reason = "browser-jar";
      else if (lower === "authorization" || lower === "proxy-authorization") reason = "forbidden-header";
      else if (BROWSER_CONTROLLED[lower]) reason = "browser-controlled";
      dropped.push({ name: name, reason: reason });
    });
    return dropped;
  }

  function decodeForm(s) {
    try {
      return decodeURIComponent(String(s).replace(/\+/g, " "));
    } catch (e) {
      return null;
    }
  }

  function parsePairs(raw, mode) {
    if (raw == null || raw === "") return [];
    var parts = mode === "plain" ? String(raw).split(/\r\n|\n|\r/) : String(raw).split("&");
    if (mode === "plain" && parts.length && parts[parts.length - 1] === "") parts.pop();
    var fields = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part === "") continue;
      var eq = part.indexOf("=");
      if (eq < 0) {
        if (mode === "plain") return null;
        var bare = decodeForm(part);
        if (bare == null) return null;
        fields.push({ name: bare, value: "" });
        continue;
      }
      var rawName = part.slice(0, eq);
      var rawValue = part.slice(eq + 1);
      if (mode === "plain") {
        fields.push({ name: rawName, value: rawValue });
        continue;
      }
      var name = decodeForm(rawName);
      var value = decodeForm(rawValue);
      if (name == null || value == null) return null;
      fields.push({ name: name, value: value });
    }
    return fields;
  }

  function pairsShape(raw) {
    var parts = String(raw).split("&");
    var any = false;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === "") continue;
      any = true;
      if (parts[i].indexOf("=") < 0) return false;
    }
    return any;
  }

  function boundaryOf(raw) {
    var parts = String(raw || "").split(";");
    for (var i = 1; i < parts.length; i++) {
      var piece = parts[i].trim();
      var eq = piece.indexOf("=");
      if (eq < 0) continue;
      if (piece.slice(0, eq).trim().toLowerCase() !== "boundary") continue;
      var val = piece.slice(eq + 1).trim();
      if (val.length >= 2 && val.charAt(0) === "\"" && val.charAt(val.length - 1) === "\"") {
        val = val.slice(1, -1);
      }
      return val;
    }
    return "";
  }

  function stripOneBreak(value, edge) {
    if (edge === "start") {
      if (value.indexOf("\r\n") === 0) return value.slice(2);
      if (value.indexOf("\n") === 0) return value.slice(1);
      return null;
    }
    if (value.slice(-2) === "\r\n") return value.slice(0, -2);
    if (value.slice(-1) === "\n") return value.slice(0, -1);
    return value;
  }

  function dispositionParam(header, wanted) {
    var i = 0;
    while (i < header.length && header.charAt(i) !== ";") i++;
    while (i < header.length) {
      if (header.charAt(i) === ";") i++;
      while (header.charAt(i) === " " || header.charAt(i) === "\t") i++;
      var start = i;
      while (i < header.length && header.charAt(i) !== "=" && header.charAt(i) !== ";") i++;
      var key = header.slice(start, i).trim().toLowerCase();
      if (i >= header.length || header.charAt(i) !== "=") continue;
      i++;
      while (header.charAt(i) === " " || header.charAt(i) === "\t") i++;
      var value = "";
      if (header.charAt(i) === "\"") {
        i++;
        while (i < header.length && header.charAt(i) !== "\"") {
          if (header.charAt(i) === "\\" && i + 1 < header.length) {
            value += header.charAt(i + 1);
            i += 2;
          } else {
            value += header.charAt(i);
            i++;
          }
        }
        if (header.charAt(i) === "\"") i++;
      } else {
        var vstart = i;
        while (i < header.length && header.charAt(i) !== ";") i++;
        value = header.slice(vstart, i).trim();
      }
      if (key === wanted) return value;
    }
    return null;
  }

  function parseMultipart(body, rawType) {
    var boundary = boundaryOf(rawType);
    if (!boundary) return null;
    var chunks = String(body).split("--" + boundary);
    if (chunks.length < 2) return null;
    var fields = [];
    for (var i = 1; i < chunks.length; i++) {
      var chunk = chunks[i];
      if (chunk.indexOf("--") === 0) break;
      chunk = stripOneBreak(chunk, "start");
      if (chunk == null) return null;
      var sep = chunk.indexOf("\r\n\r\n");
      var sepLen = 4;
      if (sep < 0) {
        sep = chunk.indexOf("\n\n");
        sepLen = 2;
      }
      if (sep < 0) return null;
      var headerBlock = chunk.slice(0, sep);
      var value = stripOneBreak(chunk.slice(sep + sepLen), "end");
      var headers = headerBlock.split(/\r\n|\n/);
      var disposition = "";
      for (var h = 0; h < headers.length; h++) {
        var colon = headers[h].indexOf(":");
        if (colon < 0) continue;
        if (headers[h].slice(0, colon).trim().toLowerCase() === "content-disposition") {
          disposition = headers[h].slice(colon + 1).trim();
        }
      }
      if (!disposition) return null;
      if (/filename\s*\*?=/i.test(disposition)) return { file: true };
      var name = dispositionParam(disposition, "name");
      if (name == null) return null;
      fields.push({ name: name, value: value });
    }
    return { file: false, fields: fields };
  }

  function tokenNames(fields) {
    var names = [];
    for (var i = 0; i < fields.length; i++) {
      if (TOKEN_FIELDS[String(fields[i].name).toLowerCase()]) names.push(fields[i].name);
    }
    return names;
  }

  function queryFields(url) {
    var fields = [];
    url.searchParams.forEach(function (value, name) {
      fields.push({ name: name, value: value });
    });
    return fields;
  }

  function renderComment(dropped, tokenFields, hadHash) {
    var lines = [];
    for (var i = 0; i < dropped.length; i++) {
      lines.push(escapeHtml(dropped[i].name).replace(/--/g, "&#45;&#45;") + ": " + dropped[i].reason);
    }
    lines.push("Token fields: " + tokenFields.map(function (name) {
      return escapeHtml(name).replace(/--/g, "&#45;&#45;");
    }).join(", "));
    lines.push("SameSite=Lax and Strict cookies are not sent on a cross-site POST.");
    if (hadHash) lines.push("Dropped hash.");
    return "<!--\n" + lines.join("\n") + "\n-->";
  }

  function renderForm(method, action, enctype, fields, dropped, tokenFields, hadHash) {
    var lines = [
      "<!DOCTYPE html>",
      "<html>",
      "<head><meta charset=\"utf-8\"></head>",
      "<body>",
      renderComment(dropped, tokenFields, hadHash)
    ];
    var open = "<form method=\"" + method + "\" action=\"" + escapeHtml(action) + "\"";
    if (enctype) open += " enctype=\"" + escapeHtml(enctype) + "\"";
    open += ">";
    lines.push(open);
    for (var i = 0; i < fields.length; i++) {
      lines.push(
        "<input type=\"hidden\" name=\"" + escapeHtml(fields[i].name) +
        "\" value=\"" + escapeHtml(fields[i].value) + "\">"
      );
    }
    lines.push("<input type=\"submit\" value=\"Submit\">");
    lines.push("</form>");
    lines.push("<script>document.forms[0].submit();</script>");
    lines.push("</body>");
    lines.push("</html>");
    return lines.join("\n");
  }

  function httpUrl(raw) {
    try {
      var url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url;
    } catch (e) {
      return null;
    }
  }

  function forCapture(request) {
    var source = request || {};
    var headers = source.requestHeaders && typeof source.requestHeaders === "object"
      ? source.requestHeaders
      : {};
    var body = source.requestBody == null ? "" : String(source.requestBody);
    var url = httpUrl(source.url);
    if (!url) return blockedPlan("bad-url", classifyDropped(headers, false), []);

    var method = String(source.method == null ? "" : source.method).trim().toUpperCase();
    if (method !== "GET" && method !== "POST") {
      return blockedPlan("method", classifyDropped(headers, false), []);
    }
    if (method === "GET" && body !== "") {
      return blockedPlan("get-with-body", classifyDropped(headers, false), []);
    }

    // A bare "#" leaves URL.hash empty and still sits on href.
    var hadHash = url.href.indexOf("#") !== -1;
    if (method === "GET") {
      var getFields = queryFields(url);
      var getTokens = tokenNames(getFields);
      var getDropped = classifyDropped(headers, false);
      return formPlan(
        renderForm("GET", url.origin + url.pathname, null, getFields, getDropped, getTokens, hadHash),
        null,
        getDropped,
        getTokens
      );
    }

    var rawType = headerValue(headers, "content-type");
    var media = mediaType(rawType);
    var fields = null;
    var enctype = null;
    if (media === "application/x-www-form-urlencoded" || media === "") {
      if (media === "" && body !== "" && !pairsShape(body)) {
        return blockedPlan("unparsed-body", classifyDropped(headers, false), []);
      }
      fields = parsePairs(body, "urlencoded");
      enctype = "application/x-www-form-urlencoded";
    } else if (media === "multipart/form-data") {
      var parsed = parseMultipart(body, rawType);
      if (!parsed) return blockedPlan("unparsed-body", classifyDropped(headers, false), []);
      if (parsed.file) return blockedPlan("file-field", classifyDropped(headers, false), []);
      fields = parsed.fields;
      enctype = "multipart/form-data";
    } else if (media === "text/plain") {
      fields = parsePairs(body, "plain");
      enctype = "text/plain";
    } else {
      return blockedPlan("content-type", classifyDropped(headers, false), []);
    }
    if (fields == null) return blockedPlan("unparsed-body", classifyDropped(headers, false), []);

    var actionUrl = new URL(url.href);
    actionUrl.hash = "";
    var tokens = tokenNames(fields);
    var dropped = classifyDropped(headers, true);
    return formPlan(
      renderForm("POST", actionUrl.href, enctype, fields, dropped, tokens, hadHash),
      enctype,
      dropped,
      tokens
    );
  }

  window.PhantomCsrf = { forCapture: forCapture };
})();
