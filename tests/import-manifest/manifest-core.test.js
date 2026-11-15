"use strict";
/* manifest-core.test.js - unit tests for the dbt manifest adapter core.
 *
 * Run: node tests/import-manifest/manifest-core.test.js (from repo root)
 *
 * Covers the adapter-side assertions of the contract testability map
 * (web/import/MANIFEST-ADAPTER-CONTRACT.md section 12): A-3, D-2 to
 * D-7, L-1 to L-9, P-1 to P-11, C-1 to C-6. The release tie has its own
 * suite (manifest-tie.test.js). The in-tool proof is TASK-017.
 *
 * Fixture provenance: fixtures/public_graph.json is a byte copy of the
 * PUBLIC graph of release rel-2026-11-15T16-52-25Z, fetched from
 * https://movahedi.ca/dbt/releases/rel-2026-11-15T16-52-25Z/public_graph.json
 * (sha256 397fefbd0e9d604606207e69a93c9bb9e60f4fab8928b67eccc8340c001ad719,
 * 24222 bytes). The synthetic manifest used for the parity test is
 * derived from that public graph in this file. The restricted bundle
 * manifest (class C-11) is never used, copied, or needed.
 *
 * No em dashes.
 */
global.self = global;

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const WEB = path.resolve(__dirname, "..", "..", "web");
const MC = require(path.join(WEB, "import/worker/manifest-core.js"));
global.ManifestCore = MC; /* parse-core looks the adapter up on the root */
const ParseCore = require(path.join(WEB, "import/worker/parse-core.js"));
const XLSX = require(path.join(WEB, "import/vendor/xlsx.full.min.js"));

const V12 = "https://schemas.getdbt.com/dbt/manifest/v12.json";
const GRAPH = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/public_graph.json"), "utf8"));
const GRAPH_TEXT = fs.readFileSync(path.join(__dirname, "fixtures/public_graph.json"), "utf8");
const GRAPH_SHA = "397fefbd0e9d604606207e69a93c9bb9e60f4fab8928b67eccc8340c001ad719";

let n = 0;
function ok(cond, msg) { n++; assert.ok(cond, msg); }
function eq(a, b, msg) { n++; assert.strictEqual(a, b, msg); }
function deepEq(a, b, msg) { n++; assert.deepStrictEqual(a, b, msg); }
function throwsCode(fn, code, msg) {
  n++;
  try { fn(); } catch (e) { assert.strictEqual(e.code, code, msg + " (got code " + (e && e.code) + ")"); return e; }
  assert.fail(msg + ": expected a throw with code " + code);
}
function sha256hex(s) { return crypto.createHash("sha256").update(s, "utf8").digest("hex"); }

/* ---------------- fixture builders ---------------- */

function nodeRec(id, type, extra) {
  const rec = {
    unique_id: id,
    resource_type: type,
    name: id.split(".").pop(),
    description: "",
    tags: [],
    depends_on: { nodes: [], macros: [] },
  };
  return Object.assign(rec, extra || {});
}

function manifestOf(nodes, extra) {
  const m = {
    metadata: {
      dbt_schema_version: V12,
      dbt_version: "2.0.11",
      project_name: "synthetic_project",
      invocation_id: "00000000-0000-0000-0000-000000000000",
    },
    nodes: nodes,
    sources: {},
  };
  return Object.assign(m, extra || {});
}

/* A synthetic manifest whose Stage A projection must equal the public
   graph exactly: one manifest node per graph node, depends_on copied
   from the graph record, plus non-allowlisted fields (raw_code,
   database, path) that must NOT cross the projection (P-6). */
function manifestFromPublicGraph() {
  const nodes = {};
  for (const gn of GRAPH.nodes) {
    nodes[gn.id] = {
      unique_id: gn.id,
      resource_type: gn.type,
      name: gn.name,
      description: gn.description,
      tags: gn.tags.slice(),
      depends_on: { nodes: gn.depends_on.slice(), macros: ["macro.synthetic.should_not_cross"] },
      config: { materialized: gn.type === "seed" ? "seed" : "view" },
      raw_code: "select 1 -- must never cross the projection",
      database: "synthetic_db",
      schema: "synthetic_schema",
      alias: gn.name,
      original_file_path: "models/" + gn.name + ".sql",
      checksum: { name: "sha256", checksum: "deadbeef" },
    };
  }
  return manifestOf(nodes);
}

function chainManifest(count) {
  const nodes = {};
  for (let i = 0; i < count; i++) {
    const id = "model.p.n" + i;
    nodes[id] = nodeRec(id, "model", {
      depends_on: { nodes: i === 0 ? [] : ["model.p.n" + (i - 1)], macros: [] },
    });
  }
  return manifestOf(nodes);
}

/* Shallow wide graph: `parents` parent nodes, `children` child nodes
   each depending on every parent, plus `extra` parent-to-parent edges
   from parent 0. Depth stays at most 3, so only the edge limit can
   trip. Total edges = children*parents + extra. */
function wideManifest(parents, children, extra) {
  const nodes = {};
  const parentIds = [];
  for (let i = 0; i < parents; i++) {
    const id = "model.p.parent" + i;
    parentIds.push(id);
    nodes[id] = nodeRec(id, "model", {
      depends_on: { nodes: i > 0 && i <= extra ? ["model.p.parent0"] : [], macros: [] },
    });
  }
  for (let c = 0; c < children; c++) {
    const id = "model.p.child" + c;
    nodes[id] = nodeRec(id, "model", { depends_on: { nodes: parentIds.slice(), macros: [] } });
  }
  return manifestOf(nodes);
}

function main() {
  /* ---------- A-3 / D-4: schema version gate ---------- */
  {
    const good = MC.parseManifestText(JSON.stringify(manifestOf({ "model.p.a": nodeRec("model.p.a", "model") })));
    eq(good.ok, true, "v12 manifest accepted");
    for (const v of ["v11", "v13"]) {
      const m = manifestOf({ "model.p.a": nodeRec("model.p.a", "model") });
      m.metadata.dbt_schema_version = "https://schemas.getdbt.com/dbt/manifest/" + v + ".json";
      const res = MC.parseManifestText(JSON.stringify(m));
      eq(res.ok, false, v + " rejected");
      eq(res.code, "UNSUPPORTED_SCHEMA_VERSION", v + " code");
    }
  }

  /* ---------- D-2 / D-3: malformed and non-manifest input ---------- */
  {
    eq(MC.parseManifestText('{"metadata": ').code, "MALFORMED_JSON", "truncated JSON");
    eq(MC.parseManifestText("[1,2,3]").code, "NOT_A_MANIFEST", "array is not a manifest");
    eq(MC.parseManifestText('"text"').code, "NOT_A_MANIFEST", "string is not a manifest");
    eq(MC.parseManifestText("{}").code, "NOT_A_MANIFEST", "empty object is not a manifest");
    const noNodes = manifestOf({}); delete noNodes.nodes;
    eq(MC.parseManifestText(JSON.stringify(noNodes)).code, "NOT_A_MANIFEST", "missing nodes object");
    const noMeta = manifestOf({}); delete noMeta.metadata;
    eq(MC.parseManifestText(JSON.stringify(noMeta)).code, "NOT_A_MANIFEST", "missing metadata object");
  }

  /* ---------- D-5: prototype pollution keys, anywhere ---------- */
  {
    const cases = [
      '{"__proto__": {"polluted": "x"}, "metadata": {}, "nodes": {}}',
      '{"metadata": {"dbt_schema_version": "' + V12 + '"}, "nodes": {"__proto__": {}}}',
      '{"metadata": {"dbt_schema_version": "' + V12 + '"}, "nodes": {}, "sources": {"constructor": {}}}',
      '{"metadata": {"dbt_schema_version": "' + V12 + '"}, "nodes": {"model.p.a": {"resource_type": "model", "name": "a", "prototype": {}}}}',
      '{"metadata": {"dbt_schema_version": "' + V12 + '"}, "nodes": {"model.p.a": {"resource_type": "model", "name": "a", "config": {"__proto__": {"polluted": "x"}}}}}',
    ];
    for (const text of cases) {
      const res = MC.parseManifestText(text);
      eq(res.ok, false, "pollution fixture rejected");
      eq(res.code, "POLLUTION_KEY", "pollution code for " + text.slice(0, 40));
      eq(({}).polluted, undefined, "Object.prototype unchanged after pollution attempt");
    }
    eq(Object.prototype.polluted, undefined, "Object.prototype clean at end of pollution block");
  }

  /* ---------- L-1: file size, checked before parsing ---------- */
  {
    const text = JSON.stringify(manifestOf({ "model.p.a": nodeRec("model.p.a", "model") }));
    const tooBig = Buffer.alloc(MC.LIMITS.MAX_FILE_BYTES + 1, 0x20);
    const resBig = MC.parseManifestBuffer(tooBig, "manifest.json");
    eq(resBig.ok, false, "10 MiB plus one byte rejected");
    eq(resBig.code, "FILE_TOO_LARGE", "file size code");
    const padded = Buffer.concat([Buffer.from(text, "utf8"),
      Buffer.alloc(MC.LIMITS.MAX_FILE_BYTES - Buffer.byteLength(text), 0x20)]);
    eq(padded.length, MC.LIMITS.MAX_FILE_BYTES, "padded fixture is exactly at the limit");
    const resExact = MC.parseManifestBuffer(padded, "manifest.json");
    eq(resExact.ok, true, "valid manifest padded to exactly 10 MiB accepted");
    eq(resExact.format, "manifest", "buffer result carries the manifest format");
  }

  /* ---------- L-2 / L-3: node and edge counts ---------- */
  {
    const nodes501 = {};
    for (let i = 0; i < 501; i++) { const id = "model.p.n" + i; nodes501[id] = nodeRec(id, "model"); }
    throwsCode(() => MC.projectManifest(manifestOf(nodes501)), "TOO_MANY_NODES", "501 projected nodes");
    const nodes500 = {};
    for (let i = 0; i < 500; i++) { const id = "model.p.n" + i; nodes500[id] = nodeRec(id, "model"); }
    eq(MC.projectManifest(manifestOf(nodes500)).projection.counts.nodes, 500, "exactly 500 nodes pass");
    /* L-R2: the limit counts the projection, not the raw manifest. */
    const mixed = {};
    for (let i = 0; i < 400; i++) { const id = "model.p.m" + i; mixed[id] = nodeRec(id, "model"); }
    for (let i = 0; i < 500; i++) { const id = "analysis.p.a" + i; mixed[id] = nodeRec(id, "analysis"); }
    eq(MC.projectManifest(manifestOf(mixed)).projection.counts.nodes, 400, "900 raw nodes, 400 projected, passes L-2");

    throwsCode(() => MC.projectManifest(wideManifest(495, 4, 21)), "TOO_MANY_EDGES", "2001 projected edges");
    eq(MC.projectManifest(wideManifest(495, 4, 20)).projection.counts.edges, 2000, "exactly 2000 edges pass");
  }

  /* ---------- L-4 to L-7: string and tag limits ---------- */
  {
    const at = (extra) => MC.projectManifest(manifestOf({ "model.p.a": nodeRec("model.p.a", "model", extra) }));
    const over = (extra, code, label) => throwsCode(
      () => MC.projectManifest(manifestOf({ "model.p.a": nodeRec("model.p.a", "model", extra) })), code, label);
    eq(at({ name: "x".repeat(200) }).projection.nodes[0].name.length, 200, "name at 200 passes");
    over({ name: "x".repeat(201) }, "OVERSIZED_NAME", "name at 201");
    /* L-R1: length counts after trimming. */
    eq(at({ name: "  " + "x".repeat(200) + "  " }).projection.nodes.length, 1, "padded name trims to 200 and passes");
    at({ description: "d".repeat(200) });
    over({ description: "d".repeat(201) }, "OVERSIZED_DESCRIPTION", "description at 201");
    at({ tags: ["t".repeat(200)] });
    over({ tags: ["t".repeat(201)] }, "OVERSIZED_TAG", "tag at 201");
    at({ tags: Array.from({ length: 20 }, (_, i) => "tag" + i) });
    over({ tags: Array.from({ length: 21 }, (_, i) => "tag" + i) }, "TOO_MANY_TAGS", "21 tags");
    n += 3; /* the three at-limit calls above that simply must not throw */
  }

  /* ---------- L-8 / L-9: depth and cycles ---------- */
  {
    eq(MC.projectManifest(chainManifest(10)).projection.counts.nodes, 10, "chain of 10 passes depth");
    throwsCode(() => MC.projectManifest(chainManifest(11)), "DEPTH_EXCEEDED", "chain of 11");
    const cyc = manifestOf({
      "model.p.a": nodeRec("model.p.a", "model", { depends_on: { nodes: ["model.p.b"], macros: [] } }),
      "model.p.b": nodeRec("model.p.b", "model", { depends_on: { nodes: ["model.p.a"], macros: [] } }),
    });
    const err = throwsCode(() => MC.projectManifest(cyc), "CYCLE_DETECTED", "2-node cycle");
    ok(err.message.includes("model.p.a") && err.message.includes("model.p.b"),
      "cycle message names both nodes: " + err.message);
  }

  /* ---------- P-1 / P-2: resource type inclusion ---------- */
  {
    const nodes = {};
    for (const t of ["model", "seed", "snapshot", "test", "analysis", "operation", "hook", "rpc", "sql_operation"]) {
      const id = t + ".p.x";
      nodes[id] = nodeRec(id, t);
    }
    const proj = MC.projectManifest(manifestOf(nodes)).projection;
    deepEq(proj.nodes.map((x) => x.type), ["model", "seed", "snapshot", "test"],
      "exactly the four P-1 types project, sorted by id");
  }

  /* ---------- P-4 / P-8: sources never render, drops counted ---------- */
  {
    const m = manifestOf({
      "model.p.a": nodeRec("model.p.a", "model", {
        depends_on: { nodes: ["source.p.raw.events", "model.p.a"], macros: [] },
      }),
    }, { sources: { "source.p.raw.events": { resource_type: "source", name: "events" } } });
    const res = MC.projectManifest(m);
    eq(res.projection.counts.nodes, 1, "source does not render");
    eq(res.projection.counts.edges, 0, "source dependency draws no edge");
    eq(res.droppedEdges, 2, "source dependency and self dependency both counted as dropped");
  }

  /* ---------- P-5: ephemeral models render, no rewiring ---------- */
  {
    const m = manifestOf({
      "model.p.a": nodeRec("model.p.a", "model"),
      "model.p.mid": nodeRec("model.p.mid", "model", {
        config: { materialized: "ephemeral" },
        depends_on: { nodes: ["model.p.a"], macros: [] },
      }),
      "model.p.b": nodeRec("model.p.b", "model", {
        depends_on: { nodes: ["model.p.mid"], macros: [] },
      }),
    });
    const proj = MC.projectManifest(m).projection;
    eq(proj.counts.nodes, 3, "ephemeral model projects as a node");
    deepEq(proj.edges, [
      { from: "model.p.a", to: "model.p.mid" },
      { from: "model.p.mid", to: "model.p.b" },
    ], "both direct edges kept, no edge skips the ephemeral node");
  }

  /* ---------- P-6: allowlist is exact ---------- */
  {
    const m = manifestOf({
      "model.p.rich": nodeRec("model.p.rich", "model", {
        description: "rich", tags: ["b", "a"],
        raw_code: "select secret", database: "db", schema: "sch", alias: "al",
        original_file_path: "models/rich.sql", columns: { c: { data_type: "int" } },
        checksum: { name: "sha256", checksum: "ff" },
      }),
    });
    const rec = MC.projectManifest(m).projection.nodes[0];
    deepEq(Object.keys(rec).sort(), ["depends_on", "description", "id", "name", "tags", "type"],
      "projected record holds exactly the six allowlisted fields");
    deepEq(rec.tags, ["a", "b"], "tags sorted ascending");
    ok(!JSON.stringify(rec).includes("secret"), "no SQL crosses the projection");
  }

  /* ---------- P-9: dedupe and deterministic order ---------- */
  {
    const m = manifestOf({
      "model.p.b": nodeRec("model.p.b", "model", {
        depends_on: { nodes: ["model.p.a", "model.p.a", "model.p.c"], macros: [] },
      }),
      "model.p.a": nodeRec("model.p.a", "model"),
      "model.p.c": nodeRec("model.p.c", "model"),
    });
    const proj = MC.projectManifest(m).projection;
    deepEq(proj.nodes.map((x) => x.id), ["model.p.a", "model.p.b", "model.p.c"], "nodes sorted by id");
    deepEq(proj.edges, [
      { from: "model.p.a", to: "model.p.b" },
      { from: "model.p.c", to: "model.p.b" },
    ], "edges deduped and sorted by (from, to)");
    deepEq(proj.nodes[1].depends_on, ["model.p.a", "model.p.c"], "depends_on deduped and sorted");
  }

  /* ---------- D-6 / D-7: malformed records ---------- */
  {
    const noName = manifestOf({ "model.p.a": nodeRec("model.p.a", "model") });
    delete noName.nodes["model.p.a"].name;
    const e1 = throwsCode(() => MC.projectManifest(noName), "MALFORMED_NODE", "missing name");
    ok(e1.message.includes("model.p.a"), "MALFORMED_NODE names the node key");
    const noType = manifestOf({ "model.p.a": nodeRec("model.p.a", "model") });
    delete noType.nodes["model.p.a"].resource_type;
    throwsCode(() => MC.projectManifest(noType), "MALFORMED_NODE", "missing resource_type");
    const mismatch = manifestOf({ "model.p.a": nodeRec("model.p.a", "model", { unique_id: "model.p.other" }) });
    throwsCode(() => MC.projectManifest(mismatch), "NODE_ID_MISMATCH", "unique_id mismatch");
  }

  /* ---------- P-10 / P-11: parity with the public graph ---------- */
  {
    const res = MC.parseManifestText(JSON.stringify(manifestFromPublicGraph()));
    eq(res.ok, true, "public-graph-derived synthetic manifest accepted");
    const proj = res.manifest.projection;
    eq(proj.counts.nodes, 45, "parity node count 45");
    eq(proj.counts.edges, 55, "parity edge count 55");
    eq(res.manifest.droppedEdges, 0, "parity dropped edges 0");
    deepEq(proj.nodes, GRAPH.nodes, "projected node set and records equal the public graph");
    deepEq(proj.edges, GRAPH.edges, "projected edge set equals the public graph");
    eq(proj.schema, "public_graph/v1", "projection schema tag");
    const canonical = MC.canonicalSerialize(proj);
    eq(canonical, GRAPH_TEXT, "canonical form is byte-equal to the published public_graph.json");
    eq(sha256hex(canonical), GRAPH_SHA, "canonical sha256 equals the descriptor graph sha256");
    /* Non-ASCII escapes as \uXXXX in canonical form (P-11). */
    const uni = MC.canonicalSerialize({ schema: "public_graph/v1", counts: { nodes: 0, edges: 0 }, nodes: [], edges: [], note: "café" });
    ok(uni.includes("caf\\u00e9"), "non-ASCII escaped in canonical form");
    ok(!uni.endsWith("\n"), "canonical form has no trailing newline");
  }

  /* ---------- Stage B: C-1 to C-6 ---------- */
  {
    const proj = MC.projectManifest(manifestOf({
      "seed.p.raw": nodeRec("seed.p.raw", "seed"),
      "model.p.a": nodeRec("model.p.a", "model", { name: "dup", depends_on: { nodes: ["seed.p.raw"], macros: [] } }),
      "model.p.b": nodeRec("model.p.b", "model", { name: "dup", depends_on: { nodes: ["model.p.a"], macros: [] } }),
      "test.p.t": nodeRec("test.p.t", "test", { depends_on: { nodes: ["model.p.b"], macros: [] } }),
    })).projection;
    const state = MC.buildCanvasState(proj, "payment");
    deepEq(Object.keys(state.nodes), ["n1", "n2", "n3", "n4"], "canvas ids n1..nN in sorted order (C-1)");
    eq(state.seq, 4, "seq equals the projected node count (C-7)");
    eq(state.nodes.n3.type, "collection", "seed maps to collection (C-3)");
    eq(state.nodes.n1.type, "system", "model maps to system (C-3)");
    eq(state.nodes.n4.type, "system", "test maps to system (C-3)");
    eq(state.nodes.n1.label, "dup (model.p.a)", "duplicate name gets the unique_id suffix (C-2)");
    eq(state.nodes.n2.label, "dup (model.p.b)", "second duplicate also suffixed (C-2)");
    eq(state.nodes.n3.label, "raw", "non-colliding label stays bare (C-2)");
    deepEq(state.edges, [
      { a: "n1", b: "n2", cat: "payment" },
      { a: "n2", b: "n4", cat: "payment" },
      { a: "n3", b: "n1", cat: "payment" },
    ], "one canvas edge per Stage A edge, in Stage A order, all carrying the visitor category (C-5, C-6)");
    for (const id of Object.keys(state.nodes)) {
      const nd = state.nodes[id];
      ok(nd.x >= 40 && nd.x <= 600 && nd.y >= 40 && nd.y <= 380, "position clamped for " + id + " (C-4)");
    }
    eq(state.nodes.n3.x, 80, "collection column x 80 (C-4)");
    eq(state.nodes.n1.x, 310, "system column x 310 (C-4)");
    throwsCode(() => MC.buildCanvasState(proj, ""), "INVALID_CATEGORY", "no category, no canvas state (C-6)");
    throwsCode(() => MC.buildCanvasState(proj, "invented"), "INVALID_CATEGORY", "invented category rejected (C-6)");
  }

  /* ---------- parse-core integration: D-1 branch, no spreadsheet change ---------- */
  {
    const manifestBuf = Buffer.from(JSON.stringify(manifestFromPublicGraph()), "utf8");
    eq(ParseCore.detectFormat("manifest.json", manifestBuf.subarray(0, 8192)), "json", ".json enters the manifest branch (D-1)");
    eq(ParseCore.detectFormat("MANIFEST.JSON", manifestBuf.subarray(0, 8192)), "json", "extension match is case-insensitive (A-2)");
    const res = ParseCore.parseFileBuffer(XLSX, manifestBuf, "manifest.json");
    eq(res.ok, true, "manifest parses through parseFileBuffer");
    eq(res.format, "manifest", "parseFileBuffer reports the manifest format");
    eq(res.manifest.projection.counts.nodes, 45, "worker path projection matches parity counts");
    const notManifest = ParseCore.parseFileBuffer(XLSX, Buffer.from('{"hello": 1}', "utf8"), "data.json");
    eq(notManifest.ok, false, "a .json that is not a manifest is rejected");
    eq(notManifest.code, "NOT_A_MANIFEST", "rejection carries the contract code");
    const csvRes = ParseCore.parseFileBuffer(XLSX, Buffer.from("a,b\n1,2\n", "utf8"), "still.csv");
    eq(csvRes.ok, true, "CSV path unchanged");
    eq(csvRes.format, "csv", "CSV format unchanged");
  }

  console.log("PASS " + n + " [manifest-core]");
}

try {
  main();
} catch (e) {
  console.error("FAIL manifest-core: " + (e && e.stack || e));
  process.exitCode = 1;
}
