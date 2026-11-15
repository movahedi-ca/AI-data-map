"use strict";
/* manifest-tie.test.js - unit tests for the adapter release tie.
 *
 * Run: node tests/import-manifest/manifest-tie.test.js (from repo root)
 *
 * Covers contract section 9 (T-1 to T-6) and the network discipline of
 * section 8 (V-2, V-3): the injected fetch stub records every URL, and
 * the tests assert the adapter requests only the three public release
 * records, in order, naming only a release ID in the path.
 *
 * Fixture provenance: the descriptor, index, and pointer values below
 * are the live public records of rel-2026-11-15T16-52-25Z, fetched from
 * movahedi.ca on 2026-11-15 (graph sha256 397fefbd..., 24222 bytes,
 * engine dbt-oss 2.0.11). The manifest summary comes from the synthetic
 * public-graph-derived manifest built in manifest-core.test.js style.
 * Note: the other live release, rel-2026-11-07T13-50-09Z, publishes the
 * SAME public graph (same sha256), so a hash mismatch case cannot be
 * built from the two live releases; the mismatch cases below use a
 * synthetic second descriptor with a different graph hash, which is
 * the honest way to exercise T-3 failure. No restricted artifact is
 * used anywhere in this suite.
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
const MT = require(path.join(WEB, "import/manifest-tie.js"));

const V12 = "https://schemas.getdbt.com/dbt/manifest/v12.json";
const GRAPH = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/public_graph.json"), "utf8"));
const GRAPH_SHA = "397fefbd0e9d604606207e69a93c9bb9e60f4fab8928b67eccc8340c001ad719";
const REL1 = "rel-2026-11-15T16-52-25Z";
const REL2 = "rel-2026-11-07T13-50-09Z";
const BASE = MT.RELEASES_BASE;

let n = 0;
function ok(cond, msg) { n++; assert.ok(cond, msg); }
function eq(a, b, msg) { n++; assert.strictEqual(a, b, msg); }
function deepEq(a, b, msg) { n++; assert.deepStrictEqual(a, b, msg); }

function sha256Hex(text) {
  return Promise.resolve(crypto.createHash("sha256").update(text, "utf8").digest("hex"));
}

function summaryFromPublicGraph() {
  const nodes = {};
  for (const gn of GRAPH.nodes) {
    nodes[gn.id] = {
      unique_id: gn.id,
      resource_type: gn.type,
      name: gn.name,
      description: gn.description,
      tags: gn.tags.slice(),
      depends_on: { nodes: gn.depends_on.slice(), macros: [] },
    };
  }
  const res = MC.parseManifestText(JSON.stringify({
    metadata: { dbt_schema_version: V12, dbt_version: "2.0.11", project_name: "dbt_privacy_inventory" },
    nodes: nodes,
    sources: {},
  }));
  assert.ok(res.ok, "synthetic manifest parses");
  return res.manifest;
}

function descriptorFor(relId, graphSha, graphBytes, version) {
  return {
    schema_version: "3.0.0",
    release_id: relId,
    source_sha: "1850504536ed3e34eaf339d90b39fa99275bace9",
    engine: { distribution: "dbt-oss", version: version || "2.0.11" },
    build_utc: "2026-11-15T16:52:25Z",
    public_assets: [{ path: "public_graph.json", sha256: graphSha, bytes: graphBytes }],
  };
}

/* A fetch stub over a route table. Records every requested URL. A route
   value of "THROW" simulates a failed fetch (T-6). */
function stubFetch(routes, calls) {
  return function (url) {
    calls.push(url);
    for (const suffix of Object.keys(routes)) {
      if (url.endsWith(suffix)) {
        const v = routes[suffix];
        if (v === "THROW") return Promise.reject(new Error("network down"));
        return Promise.resolve(JSON.parse(JSON.stringify(v)));
      }
    }
    return Promise.reject(new Error("no route for " + url));
  };
}

function liveRoutes(overrides) {
  const routes = {
    "index.json": { schema_version: "1.0.0", releases: [{ release_id: REL1 }, { release_id: REL2 }] },
    [REL1 + "/release.json"]: descriptorFor(REL1, GRAPH_SHA, 24222),
    [REL2 + "/release.json"]: descriptorFor(REL2, "0".repeat(64), 100),
    "current.json": { schema_version: "3.0.0", release_id: REL1, release_manifest_sha256: "696da418c18f02f97ad3ceea517288acf4f9a0ab19a60c7f1a222af668761431" },
  };
  return Object.assign(routes, overrides || {});
}

async function main() {
  const summary = summaryFromPublicGraph();

  /* ---------- T-1 to T-5: the reference manifest verifies ---------- */
  {
    const calls = [];
    const res = await MT.verifyReleaseTie({
      manifest: summary, releaseId: REL1, core: MC,
      fetchJson: stubFetch(liveRoutes(), calls), sha256Hex: sha256Hex,
    });
    eq(res.ok, true, "reference manifest verifies against its own release");
    eq(res.releaseId, REL1, "verified release ID returned");
    eq(res.isCurrent, true, "named release is the pointer current release (T-5)");
    deepEq(calls, [BASE + "index.json", BASE + REL1 + "/release.json", BASE + "current.json"],
      "only the three V-3 GET records are requested, in tie order");
  }

  /* ---------- T-5: a historical release still verifies ---------- */
  {
    const calls = [];
    const routes = liveRoutes({ "current.json": { release_id: REL2 } });
    /* REL1 descriptor still matches the manifest; only the pointer moved. */
    const res = await MT.verifyReleaseTie({
      manifest: summary, releaseId: REL1, core: MC,
      fetchJson: stubFetch(routes, calls), sha256Hex: sha256Hex,
    });
    eq(res.ok, true, "historical release verifies (T-5)");
    eq(res.isCurrent, false, "staleness is reported, not hidden (T-5)");
  }

  /* ---------- T-3: a different graph hash is a mismatch ---------- */
  {
    const calls = [];
    const res = await MT.verifyReleaseTie({
      manifest: summary, releaseId: REL2, core: MC,
      fetchJson: stubFetch(liveRoutes(), calls), sha256Hex: sha256Hex,
    });
    eq(res.ok, false, "manifest tied to the wrong release is rejected");
    eq(res.code, "RELEASE_MISMATCH", "hash mismatch code (T-3)");
  }

  /* ---------- T-3: a wrong byte length is a mismatch ---------- */
  {
    const routes = liveRoutes({ [REL1 + "/release.json"]: descriptorFor(REL1, GRAPH_SHA, 999) });
    const res = await MT.verifyReleaseTie({
      manifest: summary, releaseId: REL1, core: MC,
      fetchJson: stubFetch(routes, []), sha256Hex: sha256Hex,
    });
    eq(res.code, "RELEASE_MISMATCH", "byte length mismatch code (T-3)");
  }

  /* ---------- T-2: descriptor naming another release ---------- */
  {
    const routes = liveRoutes({ [REL1 + "/release.json"]: descriptorFor(REL2, GRAPH_SHA, 24222) });
    const res = await MT.verifyReleaseTie({
      manifest: summary, releaseId: REL1, core: MC,
      fetchJson: stubFetch(routes, []), sha256Hex: sha256Hex,
    });
    eq(res.code, "RELEASE_MISMATCH", "descriptor release_id mismatch code (T-2)");
  }

  /* ---------- T-4: dbt_version mismatch ---------- */
  {
    const routes = liveRoutes({ [REL1 + "/release.json"]: descriptorFor(REL1, GRAPH_SHA, 24222, "1.9.0") });
    const res = await MT.verifyReleaseTie({
      manifest: summary, releaseId: REL1, core: MC,
      fetchJson: stubFetch(routes, []), sha256Hex: sha256Hex,
    });
    eq(res.code, "RELEASE_MISMATCH", "engine version mismatch code (T-4)");
  }

  /* ---------- T-1: unlisted and malformed release IDs ---------- */
  {
    const calls = [];
    const res = await MT.verifyReleaseTie({
      manifest: summary, releaseId: "rel-2020-01-01T00-00-00Z", core: MC,
      fetchJson: stubFetch(liveRoutes(), calls), sha256Hex: sha256Hex,
    });
    eq(res.code, "UNKNOWN_RELEASE", "unlisted release code (T-1)");
    deepEq(calls, [BASE + "index.json"], "unlisted ID stops after the index fetch");

    const calls2 = [];
    const res2 = await MT.verifyReleaseTie({
      manifest: summary, releaseId: "../../secret", core: MC,
      fetchJson: stubFetch(liveRoutes(), calls2), sha256Hex: sha256Hex,
    });
    eq(res2.code, "UNKNOWN_RELEASE", "path-shaped ID rejected as unknown");
    eq(calls2.length, 0, "a malformed ID triggers no fetch at all");
  }

  /* ---------- T-6: fetch failures fail closed ---------- */
  {
    const res = await MT.verifyReleaseTie({
      manifest: summary, releaseId: REL1, core: MC,
      fetchJson: stubFetch(liveRoutes({ [REL1 + "/release.json"]: "THROW" }), []), sha256Hex: sha256Hex,
    });
    eq(res.ok, false, "blocked descriptor fetch renders nothing");
    eq(res.code, "UNVERIFIED_RELEASE", "blocked descriptor fetch code (T-6)");

    const resIdx = await MT.verifyReleaseTie({
      manifest: summary, releaseId: REL1, core: MC,
      fetchJson: stubFetch(liveRoutes({ "index.json": "THROW" }), []), sha256Hex: sha256Hex,
    });
    eq(resIdx.code, "UNVERIFIED_RELEASE", "blocked index fetch code (T-6)");

    const resBad = await MT.verifyReleaseTie({
      manifest: summary, releaseId: REL1, core: MC,
      fetchJson: stubFetch(liveRoutes({ "index.json": { nope: true } }), []), sha256Hex: sha256Hex,
    });
    eq(resBad.code, "UNVERIFIED_RELEASE", "unusable index data code (T-6)");
  }

  console.log("PASS " + n + " [manifest-tie]");
}

main().catch((e) => {
  console.error("FAIL manifest-tie: " + (e && e.stack || e));
  process.exitCode = 1;
});
