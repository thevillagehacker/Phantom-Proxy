// PhantomProxy — isolated-world bridge for page-hook intercept
// Relays MAIN-world hooks ↔ extension background
"use strict";

(function () {
  if (window.__phantomIxBridge) return;
  window.__phantomIxBridge = true;

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== "phantom-ix-hook") return;
    try {
      chrome.runtime.sendMessage({
        type: "PAGE_INTERCEPT_PAUSE",
        id: d.id,
        method: d.method,
        url: d.url,
        headers: d.headers || {},
        body: d.body || null,
        resourceType: d.resourceType || "fetch"
      });
    } catch (e) {}
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "PAGE_INTERCEPT_DECISION") {
      window.postMessage({
        source: "phantom-ix-bridge",
        type: "decision",
        id: msg.id,
        action: msg.action, // forward | drop
        method: msg.method,
        url: msg.url,
        headers: msg.headers,
        body: msg.body,
        pure: !!msg.pure
      }, "*");
    }
    if (msg.type === "PAGE_INTERCEPT_PING") {
      window.postMessage({ source: "phantom-ix-bridge", type: "enable", enabled: !!msg.enabled }, "*");
    }
  });
})();
