/**
 * s1util.js - shared primitives for the System-1 in-browser executor.
 *
 * Faithful browser ports of the primitives in teacher/lib/executor.mjs:
 * canon (canonical JSON, UTF-8 byte-order key sort), sha256hex (delegates to
 * the byte-parity-verified SHA-256 in s1tokenize.js), roundHalfUp,
 * checkStatute, and the frozen vocabularies. UMD: runs in browsers and Node.
 *
 * No network, no storage, no em dashes.
 */
(function (root, factory) {
  "use strict";
  var api = factory(root.S1Tokenize);
  if (typeof module === "object" && module !== null && typeof module.exports === "object") {
    module.exports = api;
  } else {
    root.S1Util = api;
  }
})(typeof self !== "undefined" ? self : this, function (S1Tokenize) {
  "use strict";

  if (!S1Tokenize || typeof S1Tokenize.sha256Hex !== "function") {
    throw new Error("s1util.js requires s1tokenize.js (S1Tokenize.sha256Hex) to load first.");
  }

  /* Frozen vocabularies (action-catalogue.json v1.0.0, token-schema.json). */
  var ACTIONS = [
    "abort_session", "add_collection_point", "add_node", "confirm_node",
    "connect", "export", "flag_for_review", "run_check", "set_field",
    "set_retention", "skip_recipe_item", "undo_last"
  ];
  var NODE_TYPES = ["collection", "system", "thirdparty", "destruction"];
  var NODE_TYPE_ENUM = { collection: 0, system: 1, thirdparty: 2, destruction: 3 };
  var EDGE_CATS = ["contact", "payment", "marketing"];
  var EDGE_CAT_ENUM = { contact: 0, payment: 1, marketing: 2 };
  var EDGE_CAT_ORDER = { contact: 0, marketing: 1, payment: 2 };
  var CHECK_NAMES = ["label_coverage", "connectivity", "retention_cited", "edge_categories"];
  var NON_MUTATING = {
    confirm_node: true, run_check: true, export: true,
    skip_recipe_item: true, abort_session: true
  };
  var NODE_ID_RE = /^n[1-9]\d*$/;
  var RECIPE_ID_RE = /^[A-Za-z0-9_-]+$/;
  var MAX_NODES = 64, MAX_EDGES = 64, MAX_PARAMS_BYTES = 4096;

  var LAW25_VARIANTS = [
    "law 25",
    "loi 25",
    "bill 64",
    "lprpsp",
    "modernisant des dispositions legislatives en matiere de protection des renseignements personnels",
    "renseignements personnels dans le secteur prive"
  ];
  var SECTION_RE = /([Ss][Ss]?\.?\s*[0-9]+|[Aa][Rr][Tt]\.?\s*[0-9]+|[Aa][Rr][Tt][Ii][Cc][Ll][Ee]\s+[0-9]+|[Rr]\.?\s*[0-9]+(\.[0-9]+)*|§\s*[0-9]+)/;

  function sha256hex(s) {
    return S1Tokenize.sha256Hex(s);
  }

  function checkStatute(statute) {
    if (typeof statute !== "string" || statute.length < 8) {
      return "statute must be a string of at least 8 characters.";
    }
    var lowered = statute.toLowerCase();
    var hit = null;
    for (var i = 0; i < LAW25_VARIANTS.length; i++) {
      if (lowered.indexOf(LAW25_VARIANTS[i]) !== -1) { hit = LAW25_VARIANTS[i]; break; }
    }
    if (hit) {
      return "the statute cites \"" + hit + "\", and Law 25 sets no retention periods; " +
        "it can never be the source of a number.";
    }
    if (!SECTION_RE.test(statute)) {
      return "the statute must name both the act and the section " +
        "(for example \"s. 230(4)(b)\" or \"art. 23\"); \"" + statute + "\" has no section.";
    }
    return null;
  }

  /* UTF-8 bytes of a string, for byte-order key comparison. */
  var _enc = (typeof TextEncoder !== "undefined") ? new TextEncoder() : null;
  function utf8Bytes(s) {
    if (_enc) return _enc.encode(s);
    var bytes = [], i, cp;
    for (i = 0; i < s.length; i++) {
      cp = s.codePointAt(i);
      if (cp > 0xffff) i++;
      if (cp < 0x80) bytes.push(cp);
      else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
    return bytes;
  }

  function compareUtf8Bytes(a, b) {
    var ba = utf8Bytes(a), bb = utf8Bytes(b);
    var n = Math.min(ba.length, bb.length);
    for (var i = 0; i < n; i++) {
      if (ba[i] !== bb[i]) return ba[i] - bb[i];
    }
    return ba.length - bb.length;
  }

  /**
   * Canonical JSON: object keys sorted ascending in UTF-8 byte order,
   * arrays in their given order, no whitespace. Numbers serialize plain;
   * callers round coordinates before hashing. Port of executor.mjs canon().
   */
  function canon(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) {
      return "[" + value.map(canon).join(",") + "]";
    }
    if (typeof value === "object") {
      var keys = Object.keys(value).sort(compareUtf8Bytes);
      var parts = [];
      for (var i = 0; i < keys.length; i++) {
        parts.push(JSON.stringify(keys[i]) + ":" + canon(value[keys[i]]));
      }
      return "{" + parts.join(",") + "}";
    }
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number") {
      if (!isFinite(value)) throw new Error("cannot canonicalize non-finite number");
      return JSON.stringify(value);
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    throw new Error("cannot canonicalize value of type " + typeof value);
  }

  /** First 8 hex chars of SHA-256 over canonical params JSON (digest8). */
  function digest8(params) {
    return sha256hex(canon(params)).slice(0, 8);
  }

  function roundHalfUp(n) {
    return Math.floor(n + 0.5);
  }

  function deepCopy(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function nodeNum(id) {
    return parseInt(id.slice(1), 10);
  }

  function isRealDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var parts = s.split("-").map(Number);
    var dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    return dt.getUTCFullYear() === parts[0] && dt.getUTCMonth() === parts[1] - 1 && dt.getUTCDate() === parts[2];
  }

  function todayUtc() {
    return new Date().toISOString().slice(0, 10);
  }

  function utf8ByteLength(s) {
    return utf8Bytes(s).length;
  }

  return {
    ACTIONS: ACTIONS,
    NODE_TYPES: NODE_TYPES,
    NODE_TYPE_ENUM: NODE_TYPE_ENUM,
    EDGE_CATS: EDGE_CATS,
    EDGE_CAT_ENUM: EDGE_CAT_ENUM,
    EDGE_CAT_ORDER: EDGE_CAT_ORDER,
    CHECK_NAMES: CHECK_NAMES,
    NON_MUTATING: NON_MUTATING,
    NODE_ID_RE: NODE_ID_RE,
    RECIPE_ID_RE: RECIPE_ID_RE,
    MAX_NODES: MAX_NODES,
    MAX_EDGES: MAX_EDGES,
    MAX_PARAMS_BYTES: MAX_PARAMS_BYTES,
    sha256hex: sha256hex,
    checkStatute: checkStatute,
    canon: canon,
    digest8: digest8,
    roundHalfUp: roundHalfUp,
    deepCopy: deepCopy,
    nodeNum: nodeNum,
    isRealDate: isRealDate,
    todayUtc: todayUtc,
    utf8ByteLength: utf8ByteLength,
    compareUtf8Bytes: compareUtf8Bytes
  };
});
