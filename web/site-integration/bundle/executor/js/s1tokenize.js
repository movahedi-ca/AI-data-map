/**
 * s1tokenize.js, JavaScript port of training/s1tokenize.py (encoding_version 1.0.0).
 *
 * Pure encoding helpers for the System-1 workflow model: 16-bit token ids plus
 * per-token field objects are turned into integer arrays. No learning here.
 *
 * Byte-exact parity contract with the Python implementation:
 *  - stableHash: SHA-256 over UTF-8 bytes, first 8 bytes as big-endian uint64,
 *    reduced mod buckets. Synchronous pure-JS SHA-256 is embedded below.
 *  - canonicalFields: replicates Python's
 *      json.dumps(obj, sort_keys=True, separators=(",", ":"))   (ensure_ascii=True)
 *    byte for byte, including: recursive code-point key sorting, no whitespace,
 *    lowercase-hex \uXXXX escapes for every non-ASCII char (surrogate pairs for
 *    astral plane, lone surrogates escaped as their own \uXXXX), short escapes
 *    for \b \t \n \f \r \" \\, \u00XX for other C0 controls, raw 0x7F, and
 *    Python float repr formatting (shortest round-trip digits, fixed notation
 *    for 1e-4 <= |x| < 1e16, two-digit-minimum exponents otherwise).
 *  - Integer-valued JSON literals keep Python int semantics: the parser tags
 *    integer literals (no fraction/exponent) and re-emits them verbatim, so
 *    {"x": 40} encodes as '{"x":40}' and not '{"x":40.0}'. Arbitrary-precision
 *    integer literals are supported exactly.
 *  - encodeStep mirrors the Python validation and error messages.
 *
 * CommonJS, zero dependencies, runs in Node and browsers (TextEncoder and
 * BigInt are the only platform requirements).
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module !== null && typeof module.exports === "object") {
    module.exports = api;
  } else {
    root.S1Tokenize = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Token id constants (frozen, from specs/token-schema.json, encoding 1.0.0)
  // ---------------------------------------------------------------------------
  var BOS = 0;
  var EOS = 1;
  var SNAPSHOT_SEP = 2;
  var ANNOT_SEP = 3;
  var MENU_SEP = 4;

  var NODE_LO = 32, NODE_HI = 96;
  var EDGE_LO = 96, EDGE_HI = 160;
  var ANNOT_LO = 160, ANNOT_HI = 224;
  var MENU_LO = 224, MENU_HI = 288;

  // ---------------------------------------------------------------------------
  // SHA-256 (FIPS 180-4), synchronous, pure JS. Returns a 32-byte Uint8Array.
  // ---------------------------------------------------------------------------
  var SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr32(x, n) {
    return ((x >>> n) | (x << (32 - n))) >>> 0;
  }

  function sha256Bytes(input) {
    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    var len = input.length;
    var total = len + 1 + 8;
    var paddedLen = total + ((64 - (total % 64)) % 64);
    var m = new Uint8Array(paddedLen);
    m.set(input, 0);
    m[len] = 0x80;
    var dv = new DataView(m.buffer);
    // 64-bit big-endian bit length of the original message.
    dv.setUint32(paddedLen - 8, Math.floor(len / 0x20000000));
    dv.setUint32(paddedLen - 4, (len << 3) >>> 0);

    var w = new Uint32Array(64);
    for (var off = 0; off < paddedLen; off += 64) {
      for (var t = 0; t < 16; t++) w[t] = dv.getUint32(off + t * 4);
      for (t = 16; t < 64; t++) {
        var x15 = w[t - 15], x2 = w[t - 2];
        var s0 = (rotr32(x15, 7) ^ rotr32(x15, 18) ^ (x15 >>> 3)) >>> 0;
        var s1 = (rotr32(x2, 17) ^ rotr32(x2, 19) ^ (x2 >>> 10)) >>> 0;
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = h0, b = h1, c = h2, d = h3;
      var e = h4, f = h5, g = h6, hh = h7;
      for (t = 0; t < 64; t++) {
        var S1 = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) >>> 0;
        var ch = ((e & f) ^ (~e & g)) >>> 0;
        var t1 = (hh + S1 + ch + SHA256_K[t] + w[t]) | 0;
        var S0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0;
        var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        var t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0;
      h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0;
      h6 = (h6 + g) | 0; h7 = (h7 + hh) | 0;
    }
    var out = new Uint8Array(32);
    var odv = new DataView(out.buffer);
    odv.setUint32(0, h0); odv.setUint32(4, h1);
    odv.setUint32(8, h2); odv.setUint32(12, h3);
    odv.setUint32(16, h4); odv.setUint32(20, h5);
    odv.setUint32(24, h6); odv.setUint32(28, h7);
    return out;
  }

  function sha256Hex(text) {
    var digest = sha256Bytes(utf8Encode(text));
    var s = "";
    for (var i = 0; i < digest.length; i++) {
      s += digest[i].toString(16).padStart(2, "0");
    }
    return s;
  }

  // UTF-8 encoder. TextEncoder is universal in browsers and Node >= 11;
  // the manual fallback covers exotic JS runtimes.
  var _textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  function utf8Encode(text) {
    if (_textEncoder) return _textEncoder.encode(text);
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var cp = text.codePointAt(i);
      if (cp > 0xffff) i++;
      if (cp < 0x80) {
        bytes.push(cp);
      } else if (cp < 0x800) {
        bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      } else if (cp < 0x10000) {
        bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      }
    }
    return new Uint8Array(bytes);
  }

  /**
   * Deterministic string hash into [0, buckets). Same input, same output,
   * across processes and machines.
   */
  function stableHash(text, buckets) {
    var digest = sha256Bytes(utf8Encode(text));
    var v = 0n;
    for (var i = 0; i < 8; i++) v = (v << 8n) | BigInt(digest[i]);
    return Number(v % BigInt(buckets));
  }

  // ---------------------------------------------------------------------------
  // JSON parser that preserves Python int-vs-float semantics.
  //
  // Python's json.loads maps a literal with no fraction/exponent part to int
  // (arbitrary precision) and everything else numeric to float. Plain
  // JSON.parse collapses both to JS doubles, which would turn {"x": 40} into
  // '{"x":40.0}' under Python's dumps, and would render an integer-valued
  // float literal like 1e+51 as a giant digit string instead of Python's
  // exponential repr. Numeric literals are therefore tagged at parse time
  // (int literals re-emitted verbatim; float literals formatted with the
  // Python float repr). Also accepts Python's NaN/Infinity/-Infinity
  // extensions like json.loads.
  // ---------------------------------------------------------------------------
  var S1_NUM = typeof Symbol === "function" ? Symbol("s1num") : "__s1num__";

  function s1numTag(v) {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      var tag = v[S1_NUM];
      if (tag !== undefined) return tag;
    }
    return null;
  }
  function s1int(literalText) {
    var o = {};
    o[S1_NUM] = { t: "i", v: literalText };
    return o;
  }
  function s1float(x) {
    var o = {};
    o[S1_NUM] = { t: "f", v: x };
    return o;
  }

  var JSON_NUM_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

  function parseJsonFields(text) {
    if (typeof text !== "string") {
      throw new SyntaxError("field entry must be a string, got " + typeof text);
    }
    var pos = 0;
    function fail(msg) {
      throw new SyntaxError("invalid JSON: " + msg + " (at index " + pos + ")");
    }
    function skipWs() {
      while (pos < text.length) {
        var c = text.charCodeAt(pos);
        if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++;
        else break;
      }
    }
    function parseLiteral(word, value) {
      if (text.startsWith(word, pos)) {
        pos += word.length;
        return value;
      }
      fail("unexpected token");
    }
    function parseString() {
      // pos is at the opening quote.
      pos++;
      var out = "";
      while (pos < text.length) {
        var cu = text.charCodeAt(pos);
        if (cu === 0x22) { pos++; return out; }
        if (cu === 0x5c) {
          pos++;
          if (pos >= text.length) fail("truncated escape");
          var e = text[pos];
          if (e === '"') out += '"';
          else if (e === "\\") out += "\\";
          else if (e === "/") out += "/";
          else if (e === "b") out += "\b";
          else if (e === "f") out += "\f";
          else if (e === "n") out += "\n";
          else if (e === "r") out += "\r";
          else if (e === "t") out += "\t";
          else if (e === "u") {
            var hex = text.substr(pos + 1, 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad \\u escape");
            var hi = parseInt(hex, 16);
            pos += 5;
            if (hi >= 0xd800 && hi <= 0xdbff && text.substr(pos, 2) === "\\u") {
              var hex2 = text.substr(pos + 2, 4);
              if (/^[0-9a-fA-F]{4}$/.test(hex2)) {
                var lo = parseInt(hex2, 16);
                if (lo >= 0xdc00 && lo <= 0xdfff) {
                  out += String.fromCharCode(hi, lo);
                  pos += 6;
                  continue;
                }
              }
            }
            out += String.fromCharCode(hi);
            continue;
          } else {
            fail("bad escape \\" + e);
          }
          pos++;
          continue;
        }
        if (cu < 0x20) fail("unescaped control character in string");
        out += text[pos];
        pos++;
      }
      fail("unterminated string");
    }
    function parseNumber() {
      JSON_NUM_RE.lastIndex = pos;
      var m = JSON_NUM_RE.exec(text);
      if (!m) fail("invalid number");
      pos = JSON_NUM_RE.lastIndex;
      var lit = m[0];
      if (lit.indexOf(".") !== -1 || lit.indexOf("e") !== -1 || lit.indexOf("E") !== -1) {
        return s1float(parseFloat(lit));
      }
      if (lit === "-0") lit = "0"; // Python: json.loads("-0") is int 0.
      return s1int(lit);
    }
    function parseArray() {
      pos++; // [
      var arr = [];
      skipWs();
      if (text[pos] === "]") { pos++; return arr; }
      while (true) {
        arr.push(parseValue());
        skipWs();
        var c = text[pos];
        if (c === ",") { pos++; continue; }
        if (c === "]") { pos++; return arr; }
        fail("expected ',' or ']' in array");
      }
    }
    function parseObject() {
      pos++; // {
      var obj = {};
      skipWs();
      if (text[pos] === "}") { pos++; return obj; }
      while (true) {
        skipWs();
        if (text[pos] !== '"') fail("expected string key");
        var key = parseString();
        skipWs();
        if (text[pos] !== ":") fail("expected ':' after key");
        pos++;
        obj[key] = parseValue();
        skipWs();
        var c = text[pos];
        if (c === ",") { pos++; continue; }
        if (c === "}") { pos++; return obj; }
        fail("expected ',' or '}' in object");
      }
    }
    function parseValue() {
      skipWs();
      if (pos >= text.length) fail("unexpected end of input");
      var c = text[pos];
      if (c === "{") return parseObject();
      if (c === "[") return parseArray();
      if (c === '"') return parseString();
      if (c === "t") return parseLiteral("true", true);
      if (c === "f") return parseLiteral("false", false);
      if (c === "n") return parseLiteral("null", null);
      if (c === "N") { parseLiteral("NaN", NaN); return s1float(NaN); }
      if (c === "I") { parseLiteral("Infinity", Infinity); return s1float(Infinity); }
      if (c === "-") {
        if (text.startsWith("-Infinity", pos)) {
          pos += 9;
          return s1float(-Infinity);
        }
        return parseNumber();
      }
      if (c >= "0" && c <= "9") return parseNumber();
      fail("unexpected character " + JSON.stringify(c));
    }
    var value = parseValue();
    skipWs();
    if (pos !== text.length) fail("trailing characters");
    return value;
  }

  // ---------------------------------------------------------------------------
  // canonicalFields: byte-exact replica of
  //   json.dumps(obj, sort_keys=True, separators=(",", ":"))  # ensure_ascii=True
  // ---------------------------------------------------------------------------
  var SHORT_ESCAPES = {
    0x22: '\\"',
    0x5c: "\\\\",
    0x08: "\\b",
    0x0c: "\\f",
    0x0a: "\\n",
    0x0d: "\\r",
    0x09: "\\t"
  };

  function hex4(n) {
    return n.toString(16).padStart(4, "0");
  }

  // Python's json encoder with ensure_ascii=True: escape ", \, the five
  // C0 short escapes (\b \t \n \f \r), other C0 controls and DEL (0x7F) as
  // \u00XX (lowercase hex), and every code unit >= 0x80 as \uXXXX (astral
  // chars as UTF-16 surrogate pairs, lone surrogates as their own \uXXXX).
  // (The C encoder's ESCAPE_ASCII class is [^\ -~], so 0x7F is escaped.)
  function encodeJsonString(s) {
    var out = '"';
    for (var i = 0; i < s.length; i++) {
      var cu = s.charCodeAt(i);
      var esc = SHORT_ESCAPES[cu];
      if (esc !== undefined) {
        out += esc;
        continue;
      }
      if (cu < 0x20 || cu === 0x7f) {
        out += "\\u00" + hex4(cu).slice(2);
        continue;
      }
      if (cu < 0x80) {
        out += s.charAt(i);
        continue;
      }
      if (cu >= 0xd800 && cu <= 0xdbff && i + 1 < s.length) {
        var lo = s.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          out += "\\u" + hex4(cu) + "\\u" + hex4(lo);
          i++;
          continue;
        }
      }
      out += "\\u" + hex4(cu);
    }
    return out + '"';
  }

  // Python sorts dict keys by code point. JS's default string comparison is by
  // UTF-16 code unit, which disagrees for astral characters vs U+E000-U+FFFF,
  // so compare code point by code point explicitly.
  function compareKeysByCodePoint(a, b) {
    var ia = a[Symbol.iterator]();
    var ib = b[Symbol.iterator]();
    for (;;) {
      var na = ia.next(), nb = ib.next();
      if (na.done && nb.done) return 0;
      if (na.done) return -1;
      if (nb.done) return 1;
      var ca = na.value.codePointAt(0), cb = nb.value.codePointAt(0);
      if (ca !== cb) return ca - cb;
    }
  }

  // Python float repr: shortest round-trip digits; fixed notation when
  // 1e-4 <= |x| < 1e16, otherwise exponential with a >= 2-digit exponent.
  // The shortest digits are recovered from toExponential(), which V8/
  // SpiderMonkey/JavaScriptCore all render with minimal round-trip digits.
  function encodeJsonFloat(x) {
    if (x !== x) return "NaN";
    if (x === Infinity) return "Infinity";
    if (x === -Infinity) return "-Infinity";
    if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
    var neg = x < 0;
    var ax = neg ? -x : x;
    var m = /^(\d)(?:\.(\d+))?e([+-])(\d+)$/.exec(ax.toExponential());
    if (!m) throw new Error("cannot format float: " + String(x));
    var digits = m[1] + (m[2] || "");
    var decpt = parseInt(m[4], 10) * (m[3] === "-" ? -1 : 1) + 1;
    var s;
    if (decpt <= -4 || decpt > 16) {
      var mant = digits.length > 1 ? digits.charAt(0) + "." + digits.slice(1) : digits.charAt(0);
      var e = decpt - 1;
      s = mant + "e" + (e < 0 ? "-" : "+") + String(Math.abs(e)).padStart(2, "0");
    } else if (decpt <= 0) {
      s = "0." + new Array(-decpt + 1).join("0") + digits;
    } else if (decpt >= digits.length) {
      s = digits + new Array(decpt - digits.length + 1).join("0") + ".0";
    } else {
      s = digits.slice(0, decpt) + "." + digits.slice(decpt);
    }
    return neg ? "-" + s : s;
  }

  function encodeJsonValue(v) {
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "string") return encodeJsonString(v);
    if (t === "boolean") return v ? "true" : "false";
    if (t === "number") {
      // Plain JS numbers that are integer-valued encode as Python ints;
      // non-integral values encode with Python float repr. (Values parsed by
      // parseJsonFields carry their own int/float tags, so encodeStep is
      // exact regardless.)
      if (Number.isInteger(v)) return String(BigInt(v));
      return encodeJsonFloat(v);
    }
    var numTag = s1numTag(v);
    if (numTag) return numTag.t === "i" ? numTag.v : encodeJsonFloat(numTag.v);
    if (Array.isArray(v)) {
      var parts = [];
      for (var i = 0; i < v.length; i++) parts.push(encodeJsonValue(v[i]));
      return "[" + parts.join(",") + "]";
    }
    if (t === "object") {
      var keys = Object.keys(v).sort(compareKeysByCodePoint);
      var kparts = [];
      for (var k = 0; k < keys.length; k++) {
        kparts.push(encodeJsonString(keys[k]) + ":" + encodeJsonValue(v[keys[k]]));
      }
      return "{" + kparts.join(",") + "}";
    }
    throw new TypeError("not JSON serializable: " + t);
  }

  /**
   * Canonical JSON for a field object: sorted keys, no whitespace.
   * Matches Python's json.dumps(obj, sort_keys=True, separators=(",", ":")).
   */
  function canonicalFields(fieldObj) {
    return encodeJsonValue(fieldObj);
  }

  // ---------------------------------------------------------------------------
  // encodeStep
  // ---------------------------------------------------------------------------

  // Python repr() for the scalar types that appear in error messages.
  function pyRepr(v) {
    if (typeof v === "string") {
      return "'" + v.replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, function (c) {
          return "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0");
        }) + "'";
    }
    if (typeof v === "number") {
      if (Number.isInteger(v) && !Object.is(v, -0)) return String(v);
      return encodeJsonFloat(v);
    }
    if (typeof v === "boolean") return v ? "True" : "False";
    if (v === null || v === undefined) return "None";
    try {
      return JSON.stringify(v);
    } catch (e) {
      return String(v);
    }
  }

  /**
   * Encode one labeled step into integer arrays. Returns
   * {tok_ids, field_hash, name_hash, menu_mask} like the Python version.
   * Throws named errors mirroring the Python exceptions (ValueError for
   * validation failures, AttributeError for fobj.get on a non-dict).
   */
  function valueError(msg) {
    var e = new Error(msg);
    e.name = "ValueError";
    return e;
  }

  function encodeStep(inputIds, fields, fieldBuckets, nameBuckets) {
    if (fieldBuckets === undefined) fieldBuckets = 4096;
    if (nameBuckets === undefined) nameBuckets = 1024;
    if (inputIds.length !== fields.length) {
      throw valueError(
        "input_ids (" + inputIds.length + ") and fields (" + fields.length +
        ") differ in length"
      );
    }
    var tokIds = [], fieldHash = [], nameHash = [], menuMask = [];
    for (var n = 0; n < inputIds.length; n++) {
      var tid = inputIds[n];
      // Python: isinstance(tid, int) and 0 <= tid <= 65535. (Python bools are
      // ints; JS has no bool-number, and -0.0 is not an int in Python.)
      if (typeof tid !== "number" || !Number.isInteger(tid) || Object.is(tid, -0) ||
          tid < 0 || tid > 65535) {
        throw valueError("token id out of range: " + pyRepr(tid));
      }
      var fobj;
      try {
        fobj = parseJsonFields(fields[n]);
      } catch (e) {
        throw valueError("field entry is not JSON: " + pyRepr(fields[n]));
      }
      tokIds.push(tid);
      fieldHash.push(stableHash(canonicalFields(fobj), fieldBuckets));
      var isMenu = tid >= MENU_LO && tid < MENU_HI;
      menuMask.push(isMenu);
      if (isMenu) {
        // Python does fobj.get("action_name"), which raises AttributeError
        // when the field value is not a dict.
        var ftag = s1numTag(fobj);
        if (fobj === null || typeof fobj !== "object" || Array.isArray(fobj) || ftag) {
          var typename;
          if (fobj === null) typename = "NoneType";
          else if (Array.isArray(fobj)) typename = "list";
          else if (typeof fobj === "string") typename = "str";
          else if (typeof fobj === "boolean") typename = "bool";
          else if (ftag) typename = ftag.t === "i" ? "int" : "float";
          else typename = typeof fobj;
          var ae = new Error("'" + typename + "' object has no attribute 'get'");
          ae.name = "AttributeError";
          throw ae;
        }
        var name = fobj.action_name;
        if (typeof name !== "string" || name.length === 0) {
          throw valueError("menu token missing action_name: " + pyRepr(fields[n]));
        }
        nameHash.push(stableHash(name, nameBuckets));
      } else {
        nameHash.push(0);
      }
    }
    var anyMenu = false;
    for (var k = 0; k < menuMask.length; k++) {
      if (menuMask[k]) { anyMenu = true; break; }
    }
    if (!anyMenu) {
      throw valueError("step has an empty action menu");
    }
    return {
      tok_ids: tokIds,
      field_hash: fieldHash,
      name_hash: nameHash,
      menu_mask: menuMask
    };
  }

  return {
    BOS: BOS,
    EOS: EOS,
    SNAPSHOT_SEP: SNAPSHOT_SEP,
    ANNOT_SEP: ANNOT_SEP,
    MENU_SEP: MENU_SEP,
    NODE_LO: NODE_LO,
    NODE_HI: NODE_HI,
    EDGE_LO: EDGE_LO,
    EDGE_HI: EDGE_HI,
    ANNOT_LO: ANNOT_LO,
    ANNOT_HI: ANNOT_HI,
    MENU_LO: MENU_LO,
    MENU_HI: MENU_HI,
    stableHash: stableHash,
    canonicalFields: canonicalFields,
    encodeStep: encodeStep,
    parseJsonFields: parseJsonFields,
    sha256Hex: sha256Hex // exposed for parity testing
  };
});
