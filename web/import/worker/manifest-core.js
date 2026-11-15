/* manifest-core.js
 *
 * Bounded dbt manifest adapter core for the Phase 1 import pipeline.
 * Implements web/import/MANIFEST-ADAPTER-CONTRACT.md v1.0 (TASK-016):
 * Stage A projection (section 6), limits (section 5), structural
 * validation (section 4), canonical form (P-11), and the Stage B canvas
 * mapping (section 7). The release tie lives in ../manifest-tie.js.
 *
 * Pure logic: no DOM, no network, no storage. Runs in the import Web
 * Worker (loaded by import-worker.js before parse-core.js), on the main
 * thread for Stage B (classic script on the demo pages), and in Node
 * for testing. Manifest objects are never merged into existing objects;
 * every projected record is built fresh, field by field (rule D-5).
 *
 * Exports:
 *   parseManifestText(text)        -> { ok: true, manifest } |
 *                                     { ok: false, code, error }
 *   parseManifestBuffer(buffer, filename)
 *                                  -> { ok: true, format: "manifest",
 *                                       manifest } |
 *                                     { ok: false, code, error }
 *   projectManifest(manifest)      -> { projection, droppedEdges,
 *                                       countsByType } (throws coded)
 *   canonicalSerialize(projection) -> string (rule P-11)
 *   buildCanvasState(projection, category)
 *                                  -> { nodes, edges, seq } (throws coded)
 *   adapterError(code, message)    -> Error with .code set
 *
 * A "manifest" result above is the adapter summary:
 *   { schemaVersion, dbtVersion, projectName, projection, droppedEdges,
 *     countsByType }
 * Only the allowlisted Stage A fields (P-6) cross into the projection.
 */

(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.ManifestCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SCHEMA_VERSION = "https://schemas.getdbt.com/dbt/manifest/v12.json";

  var MAX_FILE_BYTES = 10485760; /* L-1: 10 MiB */
  var MAX_NODES = 500;           /* L-2 */
  var MAX_EDGES = 2000;          /* L-3 */
  var MAX_NAME_CHARS = 200;      /* L-4 */
  var MAX_DESC_CHARS = 200;      /* L-5 */
  var MAX_TAG_CHARS = 200;       /* L-6 */
  var MAX_TAGS = 20;             /* L-7 */
  var MAX_DEPTH = 10;            /* L-8 */

  var PROJECTED_TYPES = { model: 1, seed: 1, snapshot: 1, test: 1 }; /* P-1 */
  var POLLUTION_KEYS = { "__proto__": 1, "constructor": 1, "prototype": 1 }; /* D-5 */
  var EDGE_CATS = { contact: 1, payment: 1, marketing: 1 };          /* C-6 */

  var MESSAGES = {
    FILE_TOO_LARGE: "This file is larger than 10 MB. Please choose a smaller manifest file.",
    MALFORMED_JSON: "This file is not valid JSON. Please re-export the manifest and try again.",
    NOT_A_MANIFEST: "This file is not a dbt manifest. Please choose a manifest.json file from a dbt build.",
    UNSUPPORTED_SCHEMA_VERSION: "This manifest uses a dbt schema version this tool does not support. It reads manifest schema v12 only. Please rebuild with the pinned dbt version.",
    POLLUTION_KEY: "This file contains a reserved key that is never accepted. Please fix the file and try again.",
    MALFORMED_NODE: "A node record in this manifest is missing required fields or holds a value of the wrong kind.",
    NODE_ID_MISMATCH: "A node record in this manifest has a unique_id that does not match its key.",
    OVERSIZED_NAME: "A node name in this manifest is longer than 200 characters. Please shorten it in dbt and rebuild.",
    OVERSIZED_DESCRIPTION: "A node description in this manifest is longer than 200 characters. Please shorten it in dbt and rebuild.",
    OVERSIZED_TAG: "A tag in this manifest is longer than 200 characters. Please shorten it in dbt and rebuild.",
    TOO_MANY_TAGS: "A node in this manifest has more than 20 tags. Please reduce the tags in dbt and rebuild.",
    TOO_MANY_NODES: "This manifest projects to more than 500 nodes. Please reduce the project scope and rebuild.",
    TOO_MANY_EDGES: "This manifest projects to more than 2000 edges. Please reduce the project scope and rebuild.",
    CYCLE_DETECTED: "This manifest has a dependency cycle, so it cannot be drawn.",
    DEPTH_EXCEEDED: "This manifest has a dependency chain longer than 10 nodes. Please flatten the chain in dbt and rebuild.",
    INVALID_CATEGORY: "Please choose one category for the whole import before building the map."
  };

  function adapterError(code, detail) {
    var base = MESSAGES[code] || "This manifest could not be imported.";
    var err = new Error(detail ? base + " " + detail : base);
    err.code = code;
    return err;
  }

  function fail(code, detail) {
    return { ok: false, code: code, error: adapterError(code, detail).message };
  }

  /* ---------------------------------------------------------------- */
  /* helpers                                                           */
  /* ---------------------------------------------------------------- */

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  // Length in Unicode characters after trimming (rule L-R1). Counts code
  // points, matching the exporter's Python len() on the trimmed string.
  function charLength(s) {
    var t = String(s).replace(/^\s+|\s+$/g, "");
    var n = 0;
    for (var i = 0; i < t.length; i++) {
      var c = t.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < t.length) i++; /* one code point */
      n++;
    }
    return n;
  }

  function byteLengthOf(buffer) {
    if (!buffer) return 0;
    if (typeof buffer.byteLength === "number") return buffer.byteLength;
    if (typeof buffer.length === "number") return buffer.length;
    return 0;
  }

  function decodeUTF8(buffer) {
    var bytes;
    if (buffer instanceof Uint8Array) bytes = buffer;
    else if (typeof ArrayBuffer !== "undefined" && buffer instanceof ArrayBuffer) bytes = new Uint8Array(buffer);
    else if (buffer && typeof buffer.length === "number") bytes = new Uint8Array(buffer);
    else bytes = new Uint8Array(0);
    if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  /* D-5 plus the TASK-016 brief: a pollution key anywhere in the parsed
     manifest rejects the file. Iterative walk, so a deeply nested file
     cannot overflow the call stack here. JSON.parse has already run, so
     these keys are own data properties and reading them is inert; the
     adapter never assigns them anywhere. */
  function findPollutionKey(value) {
    var stack = [value];
    while (stack.length) {
      var cur = stack.pop();
      if (Array.isArray(cur)) {
        for (var i = 0; i < cur.length; i++) stack.push(cur[i]);
      } else if (isPlainObject(cur)) {
        var keys = Object.keys(cur);
        for (var j = 0; j < keys.length; j++) {
          if (POLLUTION_KEYS[keys[j]]) return keys[j];
          stack.push(cur[keys[j]]);
        }
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* Stage A: projection (contract section 6)                          */
  /* ---------------------------------------------------------------- */

  function projectManifest(manifest) {
    if (!isPlainObject(manifest) || !isPlainObject(manifest.metadata) || !isPlainObject(manifest.nodes)) {
      throw adapterError("NOT_A_MANIFEST");
    }
    /* The pollution scan runs first: a hostile key is rejected before
       any other field of the file is trusted (D-5, fail fast D-8). */
    var badKey = findPollutionKey(manifest);
    if (badKey) throw adapterError("POLLUTION_KEY", "Key: " + badKey + ".");
    if (manifest.metadata.dbt_schema_version !== SCHEMA_VERSION) {
      throw adapterError("UNSUPPORTED_SCHEMA_VERSION");
    }

    var nodesObj = manifest.nodes;
    var keys = Object.keys(nodesObj).sort();
    var projected = [];
    var projectedSet = {};
    var countsByType = { model: 0, seed: 0, snapshot: 0, test: 0 };

    keys.forEach(function (key) {
      var rec = nodesObj[key];
      if (!isPlainObject(rec)) {
        throw adapterError("MALFORMED_NODE", "Node '" + key + "' is not an object.");
      }
      /* D-6: every record in nodes must carry the two required strings.
         D-7: a present unique_id must equal the record key. Both checks
         run for every record, projected or not, so a malformed file
         fails whole (D-8) instead of slipping past via exclusion. */
      if (typeof rec.resource_type !== "string" || typeof rec.name !== "string") {
        throw adapterError("MALFORMED_NODE", "Node '" + key + "' must carry a string resource_type and a string name.");
      }
      if (rec.unique_id !== undefined && rec.unique_id !== key) {
        throw adapterError("NODE_ID_MISMATCH", "Node '" + key + "' carries unique_id '" + String(rec.unique_id) + "'.");
      }
      if (!PROJECTED_TYPES[rec.resource_type]) return; /* P-2 */

      /* P-6 allowlist, built fresh field by field. */
      var description = "";
      if (rec.description !== undefined && rec.description !== null) {
        if (typeof rec.description !== "string") {
          throw adapterError("MALFORMED_NODE", "Node '" + key + "' has a non-string description.");
        }
        description = rec.description;
      }
      var tags = [];
      if (rec.tags !== undefined && rec.tags !== null) {
        if (!Array.isArray(rec.tags)) {
          throw adapterError("MALFORMED_NODE", "Node '" + key + "' has a non-list tags value.");
        }
        rec.tags.forEach(function (tg) {
          if (typeof tg !== "string") {
            throw adapterError("MALFORMED_NODE", "Node '" + key + "' has a non-string tag.");
          }
          tags.push(tg);
        });
      }
      if (charLength(rec.name) > MAX_NAME_CHARS) throw adapterError("OVERSIZED_NAME", "Node '" + key + "'.");
      if (charLength(description) > MAX_DESC_CHARS) throw adapterError("OVERSIZED_DESCRIPTION", "Node '" + key + "'.");
      if (tags.length > MAX_TAGS) throw adapterError("TOO_MANY_TAGS", "Node '" + key + "'.");
      tags.forEach(function (tg) {
        if (charLength(tg) > MAX_TAG_CHARS) throw adapterError("OVERSIZED_TAG", "Node '" + key + "'.");
      });
      tags.sort();

      var depNodes = [];
      if (rec.depends_on !== undefined && rec.depends_on !== null) {
        if (!isPlainObject(rec.depends_on)) {
          throw adapterError("MALFORMED_NODE", "Node '" + key + "' has a malformed depends_on value.");
        }
        if (rec.depends_on.nodes !== undefined && rec.depends_on.nodes !== null) {
          if (!Array.isArray(rec.depends_on.nodes)) {
            throw adapterError("MALFORMED_NODE", "Node '" + key + "' has a non-list depends_on.nodes value.");
          }
          rec.depends_on.nodes.forEach(function (d) {
            if (typeof d !== "string") {
              throw adapterError("MALFORMED_NODE", "Node '" + key + "' has a non-string dependency entry.");
            }
            depNodes.push(d);
          });
        }
      }

      projected.push({
        id: key,
        name: rec.name,
        type: rec.resource_type,
        description: description,
        tags: tags,
        rawDeps: depNodes
      });
      projectedSet[key] = 1;
      countsByType[rec.resource_type]++;
    });

    if (projected.length > MAX_NODES) throw adapterError("TOO_MANY_NODES"); /* L-2 */

    /* P-7, P-8, P-9: edges from depends_on.nodes, filtered to the
       projected set, deduped, sorted. Dropped entries are counted. */
    var droppedEdges = 0;
    var edgeSeen = {};
    var edges = [];
    projected.forEach(function (node) {
      var kept = [];
      var keptSeen = {};
      node.rawDeps.forEach(function (parent) {
        if (!projectedSet[parent] || parent === node.id) {
          droppedEdges++; /* P-8: unprojected parent or self-dependency */
          return;
        }
        if (!keptSeen[parent]) { keptSeen[parent] = 1; kept.push(parent); }
        var ek = parent + "\u0000" + node.id;
        if (!edgeSeen[ek]) {
          edgeSeen[ek] = 1;
          edges.push({ from: parent, to: node.id });
        }
      });
      kept.sort();
      node.depends_on = kept;
      delete node.rawDeps;
    });
    edges.sort(function (a, b) {
      if (a.from !== b.from) return a.from < b.from ? -1 : 1;
      if (a.to !== b.to) return a.to < b.to ? -1 : 1;
      return 0;
    });
    if (edges.length > MAX_EDGES) throw adapterError("TOO_MANY_EDGES"); /* L-3 */

    checkAcyclicAndDepth(projected, edges); /* L-8, L-9 */

    /* P-10 output shape, records in the exporter's field order. */
    var outNodes = projected.map(function (node) {
      return {
        depends_on: node.depends_on,
        description: node.description,
        id: node.id,
        name: node.name,
        tags: node.tags,
        type: node.type
      };
    });
    var projection = {
      counts: { edges: edges.length, nodes: outNodes.length },
      edges: edges,
      nodes: outNodes,
      schema: "public_graph/v1"
    };
    return { projection: projection, droppedEdges: droppedEdges, countsByType: countsByType };
  }

  /* L-9 cycle check (iterative DFS; the error names the cycle path) and
     L-8 longest dependency path, counted in nodes. Edges point from a
     parent to its dependent; a dependency path follows them in either
     consistent direction, so parent-to-child is used throughout. */
  function checkAcyclicAndDepth(projected, edges) {
    var children = {};
    projected.forEach(function (node) { children[node.id] = []; });
    edges.forEach(function (e) { children[e.from].push(e.to); });

    var color = {}; /* 1 = on the DFS stack, 2 = finished */
    var depthMemo = {};
    projected.forEach(function (startNode) {
      var start = startNode.id;
      if (color[start] === 2) return;
      var stack = [{ id: start, next: 0, path: [start] }];
      color[start] = 1;
      var pathStack = [start];
      while (stack.length) {
        var frame = stack[stack.length - 1];
        var kids = children[frame.id] || [];
        if (frame.next < kids.length) {
          var child = kids[frame.next++];
          if (color[child] === 1) {
            var idx = pathStack.indexOf(child);
            var cycle = pathStack.slice(idx).concat([child]);
            throw adapterError("CYCLE_DETECTED", "Cycle: " + cycle.join(" -> ") + ".");
          }
          if (color[child] !== 2) {
            color[child] = 1;
            pathStack.push(child);
            stack.push({ id: child, next: 0, path: [child] });
          }
        } else {
          var best = 0;
          kids.forEach(function (k) { if (depthMemo[k] > best) best = depthMemo[k]; });
          depthMemo[frame.id] = best + 1;
          if (depthMemo[frame.id] > MAX_DEPTH) {
            throw adapterError("DEPTH_EXCEEDED", "A chain through node '" + frame.id + "' reaches " + depthMemo[frame.id] + " nodes.");
          }
          color[frame.id] = 2;
          stack.pop();
          pathStack.pop();
        }
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* parse entry points (contract sections 3, 4, 5)                    */
  /* ---------------------------------------------------------------- */

  function summarize(manifest) {
    var result = projectManifest(manifest);
    var meta = manifest.metadata || {};
    return {
      schemaVersion: typeof meta.dbt_schema_version === "string" ? meta.dbt_schema_version : "",
      dbtVersion: typeof meta.dbt_version === "string" ? meta.dbt_version : "",
      projectName: typeof meta.project_name === "string" ? meta.project_name : "",
      projection: result.projection,
      droppedEdges: result.droppedEdges,
      countsByType: result.countsByType
    };
  }

  function parseManifestText(text) {
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return fail("MALFORMED_JSON");
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.metadata) || !isPlainObject(parsed.nodes)) {
      return fail("NOT_A_MANIFEST");
    }
    try {
      return { ok: true, manifest: summarize(parsed) };
    } catch (e) {
      if (e && e.code) return { ok: false, code: e.code, error: e.message };
      throw e;
    }
  }

  function parseManifestBuffer(buffer, filename) {
    void filename; /* detection by extension happens in parse-core (D-1) */
    if (!buffer || byteLengthOf(buffer) === 0) {
      return { ok: false, code: "EMPTY_FILE", error: "This file is empty. Please choose a file with content and try again." };
    }
    if (byteLengthOf(buffer) > MAX_FILE_BYTES) return fail("FILE_TOO_LARGE"); /* L-1, before parsing */
    var res = parseManifestText(decodeUTF8(buffer));
    if (!res.ok) return res;
    return { ok: true, format: "manifest", manifest: res.manifest };
  }

  /* ---------------------------------------------------------------- */
  /* P-11 canonical form                                               */
  /* ---------------------------------------------------------------- */

  function sortDeep(value) {
    if (Array.isArray(value)) return value.map(sortDeep);
    if (isPlainObject(value)) {
      var out = {};
      Object.keys(value).sort().forEach(function (k) { out[k] = sortDeep(value[k]); });
      return out;
    }
    return value;
  }

  /* JSON with keys sorted, 2-space indent, non-ASCII escaped as \uXXXX,
     no trailing newline: byte-equal to the exporter's public_graph.json
     for the same manifest (P-11). */
  function canonicalSerialize(projection) {
    var text = JSON.stringify(sortDeep(projection), null, 2);
    return text.replace(/[\u0080-\uffff]/g, function (ch) {
      var hex = ch.charCodeAt(0).toString(16);
      return "\\u" + "0000".slice(hex.length) + hex;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Stage B: canvas mapping (contract section 7)                      */
  /* ---------------------------------------------------------------- */

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, Math.round(v))); }

  function columnYs(count) {
    if (count === 1) return [200]; /* (80 + 320) / 2, as in state-builder */
    var out = [];
    for (var i = 0; i < count; i++) out.push(80 + (i * 240) / (count - 1));
    return out;
  }

  function buildCanvasState(projection, category) {
    if (!EDGE_CATS[category]) throw adapterError("INVALID_CATEGORY");
    var nodes = (projection && projection.nodes) || [];
    var edges = (projection && projection.edges) || [];

    /* C-2: duplicate names get a (unique_id) suffix; bare otherwise. */
    var nameCounts = {};
    nodes.forEach(function (n) { nameCounts[n.name] = (nameCounts[n.name] || 0) + 1; });

    /* C-3 type map, C-4 layout columns. */
    var byType = { collection: [], system: [] };
    var mapped = nodes.map(function (n) {
      var type = n.type === "seed" ? "collection" : "system";
      var entry = { src: n, type: type };
      byType[type].push(entry);
      return entry;
    });
    var positions = {};
    Object.keys(byType).forEach(function (type) {
      var x = type === "collection" ? 80 : 310;
      var ys = columnYs(byType[type].length);
      byType[type].forEach(function (entry, i) {
        positions[entry.src.id] = { x: clamp(x, 40, 600), y: clamp(ys[i], 40, 380) };
      });
    });

    /* C-1: ids n1..nN in the Stage A sorted node order. */
    var canvasNodes = {};
    var idOf = {};
    mapped.forEach(function (entry, i) {
      var cid = "n" + (i + 1);
      idOf[entry.src.id] = cid;
      var label = nameCounts[entry.src.name] > 1
        ? entry.src.name + " (" + entry.src.id + ")"
        : entry.src.name;
      canvasNodes[cid] = {
        type: entry.type,
        x: positions[entry.src.id].x,
        y: positions[entry.src.id].y,
        label: label
      };
    });

    /* C-5, C-6: one canvas edge per Stage A edge, one visitor category. */
    var canvasEdges = edges.map(function (e) {
      return { a: idOf[e.from], b: idOf[e.to], cat: category };
    });

    return { nodes: canvasNodes, edges: canvasEdges, seq: nodes.length };
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    LIMITS: {
      MAX_FILE_BYTES: MAX_FILE_BYTES,
      MAX_NODES: MAX_NODES,
      MAX_EDGES: MAX_EDGES,
      MAX_NAME_CHARS: MAX_NAME_CHARS,
      MAX_DESC_CHARS: MAX_DESC_CHARS,
      MAX_TAG_CHARS: MAX_TAG_CHARS,
      MAX_TAGS: MAX_TAGS,
      MAX_DEPTH: MAX_DEPTH
    },
    adapterError: adapterError,
    parseManifestText: parseManifestText,
    parseManifestBuffer: parseManifestBuffer,
    projectManifest: projectManifest,
    canonicalSerialize: canonicalSerialize,
    buildCanvasState: buildCanvasState
  };
});
