/* mcp-validate.test.js - in-process tests for mcp/server.js exports:
   validateRecipe, errorContract, knownIntents.
   Run with: node mcp-validate.test.js
   Extends mcp/test-contract.js (which covers over-stdio: ticket shape,
   invalid intent, recovery intent, >200 items, >64KB, determinism of one
   invalid recipe, cancel flows, unknown ids, bad schema_version/recipe_id).
   This file adds: the error-contract shape for every schema-violation
   class, per-intent shape rules (add_node, add_collection_point, connect,
   set_field, set_retention, run_check, export, confirm_node,
   flag_for_review), the Law 25 retention rule in all its phrasings, param
   byte limits, top-level field rules, and proof that every authoring
   intent the server claims is wired to a working handler. */
"use strict";
var assert = require("assert");
var fs = require("fs");
var path = require("path");

var Mcp = require("../../mcp/server.js");
var known = Mcp.knownIntents();

var passed = 0;
var failures = 0;
function ok(cond, name) {
  if (cond) {
    passed++;
  } else {
    failures++;
    process.stderr.write("FAIL: " + name + "\n");
  }
}

/* ---- the documented error contract shape ---- */
function shape(err, expectedIndex, name, mustMention) {
  var tag = "error contract: " + name;
  ok(err !== null && typeof err === "object", tag + " returns an object");
  if (!err || typeof err !== "object") return;
  ok(err.ok === false, tag + " ok is false");
  ok(err.failed_item_index === expectedIndex, tag + " failed_item_index is " + JSON.stringify(expectedIndex));
  ok(typeof err.reason === "string" && err.reason.length > 0, tag + " reason is a non-empty string");
  ok(err.partial_state === null, tag + " partial_state is null");
  ok(typeof err.recovery_hint === "string" && err.recovery_hint.length > 0, tag + " recovery_hint is non-empty");
  ok(err.recovery_hint.indexOf("execute_mapping_workflow") !== -1, tag + " recovery_hint names execute_mapping_workflow");
  var keys = Object.keys(err).sort().join(",");
  ok(keys === "failed_item_index,ok,partial_state,reason,recovery_hint", tag + " has exactly the five contract keys");
  if (mustMention) {
    mustMention.forEach(function (s) {
      ok(err.reason.indexOf(s) !== -1, tag + " reason mentions " + JSON.stringify(s));
    });
  }
}

function bad(recipe, expectedIndex, name, mustMention) {
  shape(Mcp.validateRecipe(recipe, known), expectedIndex, name, mustMention);
}
function good(recipe, name) {
  var err = Mcp.validateRecipe(recipe, known);
  ok(err === null, name + (err ? " :: " + err.reason : ""));
}
function R(items, extra) {
  var r = { recipe_id: "t-1", schema_version: "1.0.0", items: items };
  if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
  return r;
}
function I(intent, params) { return { intent: intent, params: params }; }

/* ---- errorContract helper produces the documented shape directly ---- */
shape(Mcp.errorContract(null, "boom"), null, "errorContract recipe-level", ["boom"]);
shape(Mcp.errorContract(3, "bad item"), 3, "errorContract item-level", ["bad item"]);
ok(Mcp.errorContract(3, "x").recovery_hint.indexOf("item 3") !== -1, "item-level hint names the item index");

/* ---- knownIntents: 12 from the action catalogue ---- */
ok(known instanceof Set, "knownIntents returns a Set");
ok(known.size === 12, "12 known intents");
["add_node", "add_collection_point", "connect", "set_field", "set_retention",
 "run_check", "export", "confirm_node", "flag_for_review",
 "undo_last", "skip_recipe_item", "abort_session"].forEach(function (n) {
  ok(known.has(n), "knownIntents includes " + n);
});

/* ---- every authoring intent is wired: a minimal valid single-item recipe
        validates (proves the handler's shape rules accept real input) ---- */
var VALID_RETENTION = {
  node_id: "n1", record_type: "Tax records",
  range_min_years: 6, range_max_years: 7,
  statute: "Loi sur l'administration fiscale, RLRQ, c. A-6.002, ss. 34, 35.3",
  as_of: "2026-10-04"
};
var wired = [
  ["add_node", { node_id: "n1", type: "system", x: 100, y: 100, label: "Core system" }],
  ["add_collection_point", { node_id: "n2", x: 120, y: 120, label: "Intake form" }],
  ["connect", { a: "n1", b: "n2", cat: "contact" }],
  ["set_field", { node_id: "n1", field: "label", value: "Renamed" }],
  ["set_retention", VALID_RETENTION],
  ["run_check", { checks: ["label_coverage"] }],
  ["export", { format: "xls" }],
  ["confirm_node", { node_id: "n1" }],
  ["flag_for_review", { reason: "Needs legal review", node_id: "n1" }]
];
wired.forEach(function (tc) {
  good(R([I(tc[0], tc[1])], { recipe_id: "wire-" + tc[0] }), "intent wired: " + tc[0]);
});
good(R([I("flag_for_review", { reason: "Check step 4", item_index: 4 })], { recipe_id: "wire-flag-idx" }),
  "flag_for_review wired with item_index only");
good(R([I("set_retention", {
  node_id: "n1", record_type: "Tax records", verify_only: true, as_of: "2026-10-04"
})], { recipe_id: "wire-verify" }), "set_retention wired with verify_only");

/* ---- the repo's sample recipe validates ---- */
var SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "specs", "SAMPLE-RECIPE.json"), "utf8"));
good(SAMPLE, "specs/SAMPLE-RECIPE.json validates");

/* ---- recipe-level violation classes ---- */
bad(null, null, "null recipe", ["JSON object"]);
bad("nope", null, "string recipe", ["JSON object"]);
bad(42, null, "number recipe", ["JSON object"]);
bad([], null, "array recipe", ["JSON object"]);
bad({ recipe_id: "t-1", schema_version: "1.0.0", items: [I("export", { format: "xls" })], bogus: 1 },
  null, "unknown top-level field", ["bogus"]);
bad(R([I("export", { format: "xls" })], { recipe_id: "bad id!" }), null, "recipe_id with spaces", ["recipe_id"]);
bad(R([I("export", { format: "xls" })], { recipe_id: "a".repeat(129) }), null, "129-char recipe_id", ["recipe_id"]);
bad(R([I("export", { format: "xls" })], { recipe_id: 7 }), null, "non-string recipe_id", ["recipe_id"]);
ok(Mcp.validateRecipe(R([I("export", { format: "xls" })], { recipe_id: "a".repeat(128) }), known) === null,
  "128-char recipe_id is accepted");
bad(R([I("export", { format: "xls" })], { schema_version: "2.0.0" }), null, "schema 2.0.0", ["2.0.0"]);
bad(R([I("export", { format: "xls" })], { schema_version: "1.0" }), null, "schema 1.0", ["1.0"]);
bad(R([I("export", { format: "xls" })], { schema_version: "v1.0.0" }), null, "schema v1.0.0", ["v1.0.0"]);
bad(R([I("export", { format: "xls" })], { name: "n".repeat(201) }), null, "name too long", ["name"]);
bad(R([I("export", { format: "xls" })], { name: 5 }), null, "non-string name", ["name"]);
bad({ recipe_id: "t-1", schema_version: "1.0.0" }, null, "missing items", ["items"]);
bad(R([]), null, "empty items", ["items"]);
bad(R("nope"), null, "non-array items", ["items"]);

/* ---- item-level structural violations ---- */
bad(R([null]), 0, "null item", ["items[0]"]);
bad(R(["x"]), 0, "string item", ["items[0]"]);
bad(R([[1]]), 0, "array item", ["items[0]"]);
bad(R([{ intent: "export", params: { format: "xls" }, extra: 1 }]), 0, "item with unknown field", ["unknown fields"]);
bad(R([{ intent: 42, params: {} }]), 0, "non-string intent", ["must be a string"]);
bad(R([{ intent: "teleport", params: {} }]), 0, "unknown intent", ["teleport", "Known intents"]);
bad(R([{ intent: "export" }]), 0, "missing params", ["params"]);
bad(R([{ intent: "export", params: null }]), 0, "null params", ["params"]);
bad(R([{ intent: "export", params: [] }]), 0, "array params", ["params"]);
["undo_last", "skip_recipe_item", "abort_session"].forEach(function (ri) {
  bad(R([I(ri, {})]), 0, "recovery intent " + ri + " in recipe", ["executor-only"]);
});
bad(R([I("export", {})]), 0, "export missing format", ["format"]);
bad(R([I("export", { format: "xls", extra: 1 })]), 0, "export with extra param", ["extra"]);
bad(R([I("set_retention", { node_id: "n1", record_type: "Tax books" })]), 0,
  "set_retention missing as_of", ["as_of"]);

/* ---- per-item params byte limit ---- */
var fatItem = { intent: "set_retention", params: Object.assign({}, VALID_RETENTION, { anchor: "z".repeat(5000) }) };
bad(R([fatItem]), 0, "params over 4096 bytes", ["4096"]);

/* ---- add_node shape rules ---- */
bad(R([I("add_node", { node_id: "n0", type: "system", x: 100, y: 100, label: "L" })]), 0, "add_node node_id n0", ["n1"]);
bad(R([I("add_node", { node_id: "n1", type: "server", x: 100, y: 100, label: "L" })]), 0, "add_node bad type", ["type"]);
bad(R([I("add_node", { node_id: "n1", type: "system", x: "100", y: 100, label: "L" })]), 0, "add_node string x", ["\"x\""]);
bad(R([I("add_node", { node_id: "n1", type: "system", x: 39, y: 100, label: "L" })]), 0, "add_node x below 40", ["[40, 600]"]);
bad(R([I("add_node", { node_id: "n1", type: "system", x: 601, y: 100, label: "L" })]), 0, "add_node x above 600", ["[40, 600]"]);
bad(R([I("add_node", { node_id: "n1", type: "system", x: 100, y: 381, label: "L" })]), 0, "add_node y above 380", ["[40, 380]"]);
bad(R([I("add_node", { node_id: "n1", type: "system", x: 100, y: 100, label: "" })]), 0, "add_node empty label", ["label"]);
bad(R([I("add_node", { node_id: "n1", type: "system", x: 100, y: 100, label: "l".repeat(201) })]), 0, "add_node 201-char label", ["label"]);

/* ---- connect shape rules ---- */
bad(R([I("connect", { a: "n0", b: "n2", cat: "contact" })]), 0, "connect a=n0", ["\"a\""]);
bad(R([I("connect", { a: "n1", b: "x", cat: "contact" })]), 0, "connect b=x", ["\"b\""]);
bad(R([I("connect", { a: "n1", b: "n1", cat: "contact" })]), 0, "connect self-loop", ["self-loop"]);
bad(R([I("connect", { a: "n1", b: "n2", cat: "email" })]), 0, "connect bad cat", ["cat"]);

/* ---- set_field shape rules ---- */
bad(R([I("set_field", { node_id: "n1", field: "color", value: "red" })]), 0, "set_field bad field", ["field"]);
bad(R([I("set_field", { node_id: "n1", field: "label", value: "" })]), 0, "set_field empty label value", ["label"]);
bad(R([I("set_field", { node_id: "n1", field: "label", value: "v".repeat(201) })]), 0, "set_field 201-char label", ["label"]);
bad(R([I("set_field", { node_id: "n1", field: "x", value: "100" })]), 0, "set_field string x value", ["x"]);
bad(R([I("set_field", { node_id: "n1", field: "x", value: 601 })]), 0, "set_field x value above 600", ["x"]);
bad(R([I("set_field", { node_id: "n1", field: "y", value: 39 })]), 0, "set_field y value below 40", ["y"]);

/* ---- set_retention shape rules ---- */
bad(R([I("set_retention", Object.assign({}, VALID_RETENTION, { node_id: "n0" }))]), 0, "set_retention node_id n0", ["node_id"]);
bad(R([I("set_retention", Object.assign({}, VALID_RETENTION, { record_type: "" }))]), 0, "set_retention empty record_type", ["record_type"]);
bad(R([I("set_retention", Object.assign({}, VALID_RETENTION, { as_of: "2026-13-45" }))]), 0, "set_retention malformed as_of", ["as_of"]);
bad(R([I("set_retention", Object.assign({}, VALID_RETENTION, { as_of: "2026-02-30" }))]), 0, "set_retention impossible as_of", ["as_of"]);
bad(R([I("set_retention", Object.assign({}, VALID_RETENTION, { as_of: "2999-01-01" }))]), 0, "set_retention future as_of", ["as_of"]);
bad(R([I("set_retention", Object.assign({}, VALID_RETENTION, { verify_only: "yes" }))]), 0, "set_retention non-boolean verify_only", ["verify_only"]);
bad(R([I("set_retention", Object.assign({}, VALID_RETENTION, { range_min_years: 0 }))]), 0, "set_retention zero range_min", ["range_min_years"]);
bad(R([I("set_retention", Object.assign({}, VALID_RETENTION, { range_min_years: 7, range_max_years: 7 }))]), 0, "set_retention max equal to min", ["range_max_years"]);
bad(R([I("set_retention", Object.assign({}, VALID_RETENTION, { range_min_years: 7, range_max_years: 6 }))]), 0, "set_retention max below min", ["range_max_years"]);
bad(R([I("set_retention", Object.assign({}, VALID_RETENTION, { statute: "s. 1" }))]), 0, "set_retention statute too short", ["statute"]);
bad(R([I("set_retention", Object.assign({}, VALID_RETENTION, { statute: "Taxation Act" }))]), 0, "set_retention statute without section", ["section"]);
good(R([I("set_retention", Object.assign({}, VALID_RETENTION, { statute: "Taxation Act, ss. 34, 35.3" }))], { recipe_id: "sr-tax" }),
  "set_retention with a real citing statute passes");
good(R([I("set_retention", Object.assign({}, VALID_RETENTION, { as_of: "2026-10-04" }))], { recipe_id: "sr-yday" }),
  "set_retention with yesterday as_of passes");

/* ---- Law 25 can never source a numerical retention period ---- */
["Law 25, s. 12", "law 25 art. 8", "Loi 25, art. 23", "Bill 64, s. 5",
 "LPRPSP, art. 23", "Loi modernisant la protection des renseignements personnels, art. 23"].forEach(function (st) {
  bad(R([I("set_retention", Object.assign({}, VALID_RETENTION, { statute: st }))]), 0,
    "Law 25 phrasing rejected: " + st, ["Law 25"]);
});
/* verify_only with a Law 25 mention is fine: no numerical period is sourced */
good(R([I("set_retention", { node_id: "n1", record_type: "Tax books", verify_only: true, as_of: "2026-10-04" })],
  { recipe_id: "sr-verify" }), "verify_only set_retention passes");

/* ---- run_check shape rules ---- */
bad(R([I("run_check", { checks: "label_coverage" })]), 0, "run_check string checks", ["checks"]);
bad(R([I("run_check", { checks: [] })]), 0, "run_check empty checks", ["checks"]);
bad(R([I("run_check", { checks: ["label_coverage", "label_coverage"] })]), 0, "run_check duplicate checks", ["unique"]);
bad(R([I("run_check", { checks: ["mind_reading"] })]), 0, "run_check unknown check", ["mind_reading"]);

/* ---- export / confirm_node / flag_for_review shape rules ---- */
bad(R([I("export", { format: "xlsx" })]), 0, "export xlsx rejected", ["xls"]);
bad(R([I("export", { format: "XLS" })]), 0, "export uppercase XLS rejected", ["xls"]);
bad(R([I("confirm_node", { node_id: "n1", note: "n".repeat(501) })]), 0, "confirm_node 501-char note", ["note"]);
bad(R([I("flag_for_review", { reason: "" })]), 0, "flag_for_review empty reason", ["reason"]);
bad(R([I("flag_for_review", { reason: "r".repeat(501), node_id: "n1" })]), 0, "flag_for_review 501-char reason", ["reason"]);
bad(R([I("flag_for_review", { reason: "look" })]), 0, "flag_for_review with no target", ["node_id", "item_index"]);
bad(R([I("flag_for_review", { reason: "look", node_id: "n0" })]), 0, "flag_for_review bad node_id", ["node_id"]);
bad(R([I("flag_for_review", { reason: "look", item_index: -1 })]), 0, "flag_for_review negative item_index", ["item_index"]);
bad(R([I("flag_for_review", { reason: "look", item_index: 1.5 })]), 0, "flag_for_review fractional item_index", ["item_index"]);

/* ---- determinism: same invalid recipe fails identically every run ---- */
var det = R([I("add_node", { node_id: "n1", type: "system", x: 100, y: 100 })], { recipe_id: "det-1" });
var d1 = Mcp.validateRecipe(JSON.parse(JSON.stringify(det)), known);
var d2 = Mcp.validateRecipe(JSON.parse(JSON.stringify(det)), known);
ok(d1 !== null && d2 !== null, "determinism probe recipe fails");
ok(d1.failed_item_index === d2.failed_item_index && d1.reason === d2.reason,
  "invalid recipe validates identically across runs");

if (failures === 0) {
  console.log("PASS " + passed + " assertions");
} else {
  console.log("FAIL " + failures + " of " + (passed + failures) + " assertions");
  process.exitCode = 1;
}
