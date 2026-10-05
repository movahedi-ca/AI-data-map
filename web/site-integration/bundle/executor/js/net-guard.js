/**
 * net-guard.js - cross-origin request counter for the trust UI.
 *
 * Instruments fetch, XMLHttpRequest, WebSocket, and navigator.sendBeacon and
 * counts requests whose origin differs from the page's origin. Same-origin
 * loads of the page's own vendored assets (scripts, wasm, model) are page
 * loads, not data leaving the device, so they do not count. blob: and data:
 * URLs never leave the page and do not count either.
 *
 * Load this script FIRST, before any other script that could issue a
 * request, so the instrumentation is in place from the start.
 *
 * Exposes window.__s1net = { count(), log(), reset(), setNetCount(el) }.
 * No em dashes.
 */
(function () {
  "use strict";

  var root = (typeof window !== "undefined") ? window : (typeof self !== "undefined" ? self : this);

  var count = 0;
  var log = [];

  function pageOrigin() {
    try { return new URL(root.location.href).origin; } catch (e) { return ""; }
  }

  function isExternal(url) {
    try {
      var u = new URL(String(url), root.location.href);
      if (u.protocol === "blob:" || u.protocol === "data:") return false;
      return u.origin !== pageOrigin();
    } catch (e) {
      return false;
    }
  }

  function note(url, kind) {
    if (isExternal(url)) {
      count++;
      if (log.length < 100) log.push({ kind: kind, url: String(url), at: new Date().toISOString() });
    }
  }

  /* fetch */
  if (typeof root.fetch === "function") {
    var rawFetch = root.fetch.bind(root);
    root.fetch = function (input, init) {
      var url = (typeof input === "string") ? input : (input && input.url);
      note(url, "fetch");
      return rawFetch(input, init);
    };
  }

  /* XMLHttpRequest */
  if (root.XMLHttpRequest && root.XMLHttpRequest.prototype) {
    var rawOpen = root.XMLHttpRequest.prototype.open;
    root.XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__s1url = url; } catch (e) { /* ignore */ }
      return rawOpen.apply(this, arguments);
    };
    var rawSend = root.XMLHttpRequest.prototype.send;
    root.XMLHttpRequest.prototype.send = function () {
      note(this.__s1url, "xhr");
      return rawSend.apply(this, arguments);
    };
  }

  /* WebSocket */
  if (typeof root.WebSocket === "function") {
    var RawWS = root.WebSocket;
    root.WebSocket = function (url, protocols) {
      note(url, "websocket");
      return protocols === undefined ? new RawWS(url) : new RawWS(url, protocols);
    };
    root.WebSocket.prototype = RawWS.prototype;
  }

  /* sendBeacon */
  if (root.navigator && typeof root.navigator.sendBeacon === "function") {
    var rawBeacon = root.navigator.sendBeacon.bind(root.navigator);
    root.navigator.sendBeacon = function (url, data) {
      note(url, "beacon");
      return rawBeacon(url, data);
    };
  }

  /* setNetCount(el): the ONE write path for every "requests sent" counter
     element (quick flow, chat flow, page-level, and the Start-over rebuild).
     Coerces the count to a plain digit string and falls back to "0" on any
     unexpected value, so the element can never render empty, "undefined",
     or a debug string, even if this script ran before the element existed. */
  function setNetCount(el) {
    var txt = "0";
    try {
      var n = count;
      if (typeof n === "number" && isFinite(n) && n >= 0) txt = String(Math.floor(n));
    } catch (e) { /* fall back to "0" */ }
    try {
      if (el) el.textContent = txt;
    } catch (e) { /* element detached or read-only; keep "0" */ }
    return txt;
  }

  root.__s1net = {
    count: function () { return count; },
    log: function () { return log.slice(); },
    reset: function () { count = 0; log = []; },
    setNetCount: setNetCount
  };
})();
