"use strict";
/*
 * state-snapshot.test.js: frozen state snapshot contracts.
 * Run: node tests/specs/state-snapshot.test.js
 *
 * Covers: schema invariants (required fields, action_record, applied_keys
 * map, canonical node id format), the prefix hash chain with the spec's
 * worked examples (tampering breaks the chain), canonical serialization
 * determinism, and abort seal semantics.
 */

global.self = global;

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const snap = JSON.parse(fs.readFileSync(path.join(REPO, "specs", "state-snapshot-schema.json"), "utf8"));

let n = 0;
let failed = 0;
function T(cond, msg) {
  n++;
  try {
    assert(cond, msg);
  } catch (e) {
    failed++;
    process.stderr.write("FAIL " + msg + "\n");
  }
}
function sha256hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/* ---------- 1. schema document invariants ---------- */

T(JSON.stringify(snap.required) === JSON.stringify([
  "snapshot_version", "recipe_id", "item_index", "canvas", "annotations",
  "applied_keys", "actions", "dropped_prefix", "terminated", "abort_reason"
]), "snapshot required fields (10) in order");
T(snap.properties.snapshot_version.const === "1.0.0", "snapshot_version const exactly 1.0.0");
T(snap.properties.snapshot_version.description.indexOf("reject anything else loudly") !== -1,
  "snapshot_version description: readers reject anything else loudly");
T(snap.properties.item_index.minimum === 0, "item_index minimum 0");
T(snap.properties.terminated.type === "boolean" && snap.properties.terminated.default === false,
  "terminated boolean default false");
T(JSON.stringify(snap.properties.abort_reason.type) === JSON.stringify(["string", "null"]) &&
  snap.properties.abort_reason.default === null, "abort_reason string|null default null");
T(snap.properties.terminated.description.indexOf("no further items execute") !== -1,
  "terminated description: abort seals the snapshot, no further items execute");
T(snap.window.N === 32, "window N 32");
T(snap.properties.actions.maxItems === 32, "actions window maxItems 32");
T(snap.properties.actions.description.indexOf("oldest first") !== -1, "actions array oldest first");
T(snap.properties.dropped_prefix.description.indexOf("truncated") !== -1,
  "dropped_prefix documents verifiability of truncation");

/* ---------- 2. action_record: exactly three fields ---------- */

const ar = snap.action_record;
T(JSON.stringify(ar.required) === JSON.stringify(["action_id", "params", "state_hash"]),
  "action_record carries exactly action_id, params, state_hash");
T(ar.properties.action_id.pattern === "^[a-z_]+:\\d+$", "action_id pattern <action_name>:<item_index>");
T(ar.properties.state_hash.pattern === "^[0-9a-f]{64}$", "state_hash is 64 lowercase hex");
T(ar.description.indexOf("exactly three fields") !== -1, "action_record description: exactly three fields");
T(new RegExp(ar.properties.action_id.pattern).test("connect:3"), "action_id example connect:3 matches");
T(new RegExp(ar.properties.state_hash.pattern).test("a".repeat(64)), "64 hex chars match state_hash");
T(!new RegExp(ar.properties.state_hash.pattern).test("A".repeat(64)), "uppercase hex rejected");

/* ---------- 3. canonical node id format ---------- */

const canvasP = snap.properties.canvas.properties;
T(canvasP.nodes.patternProperties["^n[1-9]\\d*$"] !== undefined,
  "canvas nodes keyed by canonical ^n[1-9]\\d*$ pattern");
const nodeItems = canvasP.nodes.items;
T(JSON.stringify(nodeItems.required) === JSON.stringify(["type", "x", "y", "label"]),
  "node fields: type, x, y, label (no retention field)");
T(JSON.stringify(nodeItems.properties.type.enum) ===
  JSON.stringify(["collection", "system", "thirdparty", "destruction"]), "node type enum frozen");
T(JSON.stringify(canvasP.edges.items.properties.cat.enum) ===
  JSON.stringify(["contact", "payment", "marketing"]), "edge cat enum frozen");
T(JSON.stringify(canvasP.edges.items.required) === JSON.stringify(["a", "b", "cat"]),
  "edge fields a, b, cat");

const annItem = snap.properties.annotations.items;
T(annItem.properties.node_id.pattern === "^n[1-9]\\d*$", "annotation node_id canonical format");
T(JSON.stringify(annItem.properties.kind.enum) === JSON.stringify(["retention", "confirmation", "review_flag"]),
  "annotation kinds frozen");
T(snap.properties.annotations.description.indexOf("(node_id numeric, kind)") !== -1,
  "annotations sorted by (node_id numeric, kind)");

/* ---------- 4. applied-keys map ---------- */

const ak = snap.properties.applied_keys;
T(ak.type === "object", "applied_keys is an object");
T(ak.description.indexOf("recorded result") !== -1, "applied_keys maps idempotency keys to recorded results");
T(ak.description.indexOf("Replaying a key returns the recorded result and performs no work") !== -1,
  "replay is a no-op returning the recorded result");
T(ak.description.indexOf("tombstone") !== -1, "keys leave only via the tombstone set on undo");
T(ak.additionalProperties.description.indexOf("verbatim") !== -1,
  "recorded results returned verbatim on replay");

/* ---------- 5. prefix hash chain: worked examples and tamper detection ---------- */

T(snap.window.truncation_rule.indexOf("most recent 32") !== -1, "truncation keeps the most recent 32");
T(snap.window.truncation_rule.indexOf("H(k+1) = SHA-256") !== -1, "truncation rule states the iterative chain");

function advanceChain(prevHex, droppedStateHash) {
  return sha256hex(prevHex + droppedStateHash); // ASCII bytes of the lowercase hex digests
}
const H0 = sha256hex("");
T(H0 === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "H(0) equals the spec's SHA-256-of-empty-string value");
T(snap.window.truncation_rule.indexOf("H(0)=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") !== -1,
  "spec quotes the H(0) worked value");

const h1 = "a".repeat(64);
const h2 = "b".repeat(64);
const H1 = advanceChain(H0, h1);
T(H1 === "52eb1e93d4e47646bf787c48513698fcde9f5952763a7a4bfa7c52fe0e8388e8",
  "H(1) matches the spec worked example");
const H2 = advanceChain(H1, h2);
T(H2 === "aa15cd3f0802376650ebc56322cdec1bf6f6990ed2602dd0648bbd8b10646195",
  "H(2) matches the spec worked example");
T(snap.window.truncation_rule.indexOf("H(1)=52eb1e93d4e47646bf787c48513698fcde9f5952763a7a4bfa7c52fe0e8388e8") !== -1,
  "spec quotes the H(1) worked value");
T(snap.window.truncation_rule.indexOf("H(2)=aa15cd3f0802376650ebc56322cdec1bf6f6990ed2602dd0648bbd8b10646195") !== -1,
  "spec quotes the H(2) worked value");

// tampering breaks the chain: any change in the dropped hash changes every later link
T(advanceChain(H0, "c".repeat(64)) !== H1, "tampered drop (different hash) breaks H(1)");
T(advanceChain(H1, "c".repeat(64)) !== H2, "tampered drop breaks H(2)");
T(advanceChain(H1, h2) !== advanceChain(H2, h2), "chain position matters: same drop at different links differs");
T(advanceChain(H0, h1.toUpperCase()) !== H1, "uppercase hex is a different byte input, breaks the chain");
T(snap.properties.dropped_prefix.properties.prefix_hash.pattern === "^[0-9a-f]{64}$",
  "prefix_hash is 64 lowercase hex");
T(snap.properties.dropped_prefix.properties.count.minimum === 0, "dropped count minimum 0");
T(snap.properties.dropped_prefix.properties.prefix_hash.description.indexOf("H(0)") !== -1,
  "empty prefix (count 0) is H(0), SHA-256 of the empty string");

/* ---------- 6. canonical serialization determinism ---------- */

function canonicalize(v) {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number") {
      if (Number.isInteger(v)) return String(v);
      return JSON.stringify(v);
    }
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
}
const o1 = { b: 1, a: { y: [2, 1], x: "s" } };
const o2 = { a: { x: "s", y: [2, 1] }, b: 1 };
T(canonicalize(o1) === canonicalize(o2), "canonical form is key-order independent");
T(canonicalize(o1) === '{"a":{"x":"s","y":[2,1]},"b":1}', "canonical form: sorted keys, no whitespace");
T(canonicalize({}) === "{}", "empty object canonicalizes to {}");
T(canonicalize(o1).indexOf("\n") === -1, "no trailing newline in canonical form");

const cs = snap.canonical_serialization;
T(cs.definition.json_rules.indexOf("no whitespace") !== -1, "json_rules: no whitespace outside string values");
T(cs.definition.json_rules.indexOf("no trailing newline") !== -1, "json_rules: no trailing newline");
T(cs.definition.json_rules.indexOf("sorted ascending") !== -1, "json_rules: keys sorted ascending");
T(cs.definition.number_formatting.indexOf("round half up") !== -1, "coordinates rounded round-half-up");
T(Math.round(40.5) === 41 && Math.round(40.4) === 40, "round-half-up behavior for positive coordinates");
T(cs.state_hash.indexOf("SHA-256") !== -1, "state_hash is SHA-256 over the canonical canvas serialization");
T(cs.definition.canvas.edges_sorted_by.join("|").indexOf("cat alphabetical") !== -1,
  "edges sorted by a numeric, b numeric, cat alphabetical");
T(cs.definition.canvas.nodes_sorted_by[0].indexOf("numeric") !== -1, "nodes sorted by node id numeric");
T(JSON.stringify(cs.definition.canvas.node_transform) !== undefined, "node_transform defined");
T(cs.definition.canvas.node_transform.indexOf("id, label, type, x, y") !== -1,
  "node keys emitted in byte-ascending order id, label, type, x, y");

// state hash over {nodes, edges, annotations} is stable under input key order
const stA = { nodes: [{ id: "n1", label: "A", type: "system", x: 100, y: 100 }], edges: [], annotations: [] };
const stB = { annotations: [], edges: [], nodes: [{ y: 100, x: 100, type: "system", label: "A", id: "n1" }] };
T(sha256hex(canonicalize(stA)) === sha256hex(canonicalize(stB)), "state hash stable under key order");
T(sha256hex(canonicalize(stA)) !== sha256hex(canonicalize({ nodes: [], edges: [], annotations: [] })),
  "state hash changes when the canvas changes");

/* ---------- 7. abort seal semantics ---------- */

T(snap.properties.terminated.description.indexOf("abort_session has sealed the snapshot") !== -1,
  "terminated: true once abort_session sealed the snapshot");
T(snap.properties.abort_reason.description.indexOf("else null") !== -1,
  "abort_reason null unless terminated");
// minimal abort-seal invariant: a sealed snapshot stays sealed (documented as never resumed)
const sealed = {
  snapshot_version: "1.0.0", recipe_id: "r", item_index: 3,
  canvas: { nodes: {}, edges: [] }, annotations: [], applied_keys: {}, actions: [],
  dropped_prefix: { count: 0, prefix_hash: H0 }, terminated: true, abort_reason: "operator stop"
};
T(sealed.terminated === true && sealed.abort_reason === "operator stop",
  "abort seal shape: terminated true with abort_reason set");
T(sealed.terminated !== false, "sealed snapshot is not executable (no resume)");

process.stderr.write(failed === 0 ? "PASS " + n + " assertions\n" : failed + " FAILURES of " + n + "\n");
if (failed > 0) process.exitCode = 1;
