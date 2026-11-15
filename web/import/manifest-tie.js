/* manifest-tie.js
 *
 * Release tie for the dbt manifest adapter, contract section 9 of
 * web/import/MANIFEST-ADAPTER-CONTRACT.md (TASK-016).
 *
 * The visitor names a release ID. This module verifies, fail closed:
 *   T-1 the named release appears in the public index;
 *   T-2 the release descriptor names the same release ID;
 *   T-3 the SHA-256 of the locally computed Stage A projection, in the
 *       P-11 canonical form, equals the descriptor's public_graph.json
 *       sha256 (and the byte length matches);
 *   T-4 the manifest dbt_version equals the descriptor engine version
 *       (the schema version is already gated by rule A-3 upstream);
 *   T-5 whether the named release is the pointer's current release.
 * Any fetch failure or unusable record rejects with UNVERIFIED_RELEASE
 * (T-6). There is no offline mode and no skip option.
 *
 * Privacy (contract section 8): the only requests are GET requests for
 * the three public release records below, naming only a release ID in
 * the path. No file content, no manifest field, no projection, and no
 * hash leaves the device; the projection hash is computed locally and
 * compared locally (V-2, V-3). Nothing is persisted (V-4).
 *
 * Test seam: verifyReleaseTie accepts injected fetchJson and sha256Hex
 * functions. The defaults use the browser fetch and SubtleCrypto APIs.
 * The release ID is validated against a strict pattern before it is
 * placed in any URL path, so a hostile ID cannot alter the path shape.
 */

(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.ManifestTie = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var RELEASES_BASE = "https://movahedi.ca/dbt/releases/";
  var RELEASE_ID_RE = /^rel-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

  var MESSAGES = {
    UNKNOWN_RELEASE: "That release ID is not in the published release list. Please name a published release.",
    RELEASE_MISMATCH: "This manifest does not match the named release. Please name the release this manifest belongs to.",
    UNVERIFIED_RELEASE: "The release records could not be reached or read, so the release tie cannot be verified. Nothing was drawn. Please retry when the records are reachable."
  };

  function tieError(code) {
    var err = new Error(MESSAGES[code]);
    err.code = code;
    return err;
  }

  function reject(code) {
    return { ok: false, code: code, error: MESSAGES[code] };
  }

  /* The single network call site of the adapter. GET only, no body,
     no headers carrying visitor data. Paths are built by the caller
     from the fixed base and validated parts only. */
  function defaultFetchJson(url) {
    return fetch(url, { method: "GET" }).then(function (res) {
      if (!res || !res.ok) throw new Error("release record request failed");
      return res.json();
    });
  }

  function defaultSha256Hex(text) {
    var bytes = new TextEncoder().encode(text);
    return crypto.subtle.digest("SHA-256", bytes).then(function (buf) {
      var view = new Uint8Array(buf);
      var hex = "";
      for (var i = 0; i < view.length; i++) {
        var h = view[i].toString(16);
        hex += h.length === 1 ? "0" + h : h;
      }
      return hex;
    });
  }

  function utf8ByteLength(text) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
    return unescape(encodeURIComponent(text)).length;
  }

  function indexIds(index) {
    var list = Array.isArray(index) ? index : (index && index.releases);
    if (!Array.isArray(list)) return null;
    var ids = [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      var id = typeof entry === "string" ? entry : (entry && entry.release_id);
      if (typeof id !== "string") return null;
      ids.push(id);
    }
    return ids;
  }

  /* verifyReleaseTie({ manifest, releaseId, core, fetchJson, sha256Hex,
     baseUrl }) -> Promise<{ ok: true, releaseId, isCurrent } |
                           { ok: false, code, error }>
     `manifest` is the ManifestCore adapter summary; `core` is the
     ManifestCore module (injected so this file stays dependency-free). */
  function verifyReleaseTie(opts) {
    var o = opts || {};
    var core = o.core;
    var fetchJson = o.fetchJson || defaultFetchJson;
    var sha256Hex = o.sha256Hex || defaultSha256Hex;
    var base = o.baseUrl || RELEASES_BASE;
    var releaseId = o.releaseId;

    if (!core || !o.manifest || !o.manifest.projection) {
      return Promise.resolve(reject("UNVERIFIED_RELEASE"));
    }
    if (typeof releaseId !== "string" || !RELEASE_ID_RE.test(releaseId)) {
      return Promise.resolve(reject("UNKNOWN_RELEASE"));
    }

    var index;
    var descriptor;
    return Promise.resolve()
      .then(function () { return fetchJson(base + "index.json"); })
      .then(function (idx) {
        index = idx;
        var ids = indexIds(index);
        if (!ids) throw tieError("UNVERIFIED_RELEASE");
        if (ids.indexOf(releaseId) === -1) throw tieError("UNKNOWN_RELEASE");
        return fetchJson(base + releaseId + "/release.json");
      })
      .then(function (desc) {
        descriptor = desc;
        if (!descriptor || descriptor.release_id !== releaseId) {
          throw tieError("RELEASE_MISMATCH");
        }
        var engine = descriptor.engine || {};
        if (engine.version !== o.manifest.dbtVersion) {
          throw tieError("RELEASE_MISMATCH"); /* T-4 */
        }
        var assets = Array.isArray(descriptor.public_assets) ? descriptor.public_assets : [];
        var graph = null;
        assets.forEach(function (a) { if (a && a.path === "public_graph.json") graph = a; });
        if (!graph || typeof graph.sha256 !== "string") {
          throw tieError("UNVERIFIED_RELEASE");
        }
        var canonical = core.canonicalSerialize(o.manifest.projection);
        if (typeof graph.bytes === "number" && graph.bytes !== utf8ByteLength(canonical)) {
          throw tieError("RELEASE_MISMATCH"); /* T-3 byte length */
        }
        return sha256Hex(canonical).then(function (hex) {
          if (hex !== graph.sha256) throw tieError("RELEASE_MISMATCH"); /* T-3 */
          return fetchJson(base + "current.json");
        });
      })
      .then(function (pointer) {
        if (!pointer || typeof pointer.release_id !== "string") {
          throw tieError("UNVERIFIED_RELEASE");
        }
        return {
          ok: true,
          releaseId: releaseId,
          isCurrent: pointer.release_id === releaseId /* T-5 */
        };
      })
      .catch(function (e) {
        if (e && e.code && MESSAGES[e.code]) return reject(e.code);
        return reject("UNVERIFIED_RELEASE"); /* T-6: fail closed */
      });
  }

  return {
    RELEASES_BASE: RELEASES_BASE,
    RELEASE_ID_RE: RELEASE_ID_RE,
    verifyReleaseTie: verifyReleaseTie
  };
});
