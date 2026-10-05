"use strict";
/*
 * recipe-schema.test.js: frozen recipe schema contracts.
 * Run: node tests/specs/recipe-schema.test.js
 *
 * Layer 1: structural invariants of specs/recipe-schema.json itself
 * (required properties, enums, conditional blocks, version freeze).
 * Layer 2: real-validator behavior through mcp/server.js validateRecipe
 * (SAMPLE-RECIPE.json must pass; crafted must-fail fixtures must fail
 * with a useful error contract).
 */

global.self = global;

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const schema = JSON.parse(fs.readFileSync(path.join(REPO, "specs", "recipe-schema.json"), "utf8"));
const SAMPLE = JSON.parse(fs.readFileSync(path.join(REPO, "specs", "SAMPLE-RECIPE.json"), "utf8"));
const { validateRecipe, errorContract, knownIntents } = require(path.join(REPO, "mcp", "server.js"));
const known = knownIntents();

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

/* ---------- 1. top-level schema document invariants ---------- */

T(schema.$schema === "https://json-schema.org/draft/2020-12/schema", "schema uses draft 2020-12");
T(schema.type === "object", "top level is an object");
T(schema.additionalProperties === false, "top level additionalProperties false");
T(JSON.stringify(schema.required) === JSON.stringify(["schema_version", "recipe_id", "items"]),
  "required is exactly [schema_version, recipe_id, items]");
T(schema.description.indexOf("1.0.0") !== -1, "description names frozen 1.0.0");

/* ---------- 2. version freeze ---------- */

const svRe = new RegExp(schema.properties.schema_version.pattern);
T(svRe.test("1.0.0"), "schema_version 1.0.0 matches pattern");
T(svRe.test("1.0.3"), "schema_version 1.0.3 (patch) matches pattern");
T(!svRe.test("1.1.0"), "schema_version 1.1.0 rejected by pattern");
T(!svRe.test("2.0.0"), "schema_version 2.0.0 rejected by pattern");
T(!svRe.test("1.0"), "schema_version 1.0 (no patch) rejected by pattern");
T(schema.properties.schema_version.description.indexOf("Phase 0 freezes") !== -1,
  "schema_version description documents the freeze");

const ridRe = new RegExp(schema.properties.recipe_id.pattern);
T(ridRe.test("cafe-nord-sample-01"), "sample recipe_id matches pattern");
T(!ridRe.test("bad id!"), "recipe_id with space/bang rejected");
T(schema.properties.recipe_id.minLength === 1 && schema.properties.recipe_id.maxLength === 128,
  "recipe_id length bounds 1..128");

/* ---------- 3. intent enum ---------- */

const itemSchema = schema.properties.items.items;
const intentEnum = itemSchema.properties.intent.enum;
T(Array.isArray(intentEnum) && intentEnum.length === 12, "intent enum has 12 entries, got " + intentEnum.length);
const AUTHORING = ["add_node", "add_collection_point", "connect", "set_field", "set_retention",
  "confirm_node", "flag_for_review", "run_check", "export"];
const RECOVERY = ["undo_last", "skip_recipe_item", "abort_session"];
for (const i of AUTHORING.concat(RECOVERY)) T(intentEnum.indexOf(i) !== -1, "intent enum includes " + i);
T(itemSchema.required.indexOf("intent") !== -1 && itemSchema.required.indexOf("params") !== -1,
  "items require intent and params");
T(itemSchema.additionalProperties === false, "item additionalProperties false");

/* ---------- 4. items bounds and size limits ---------- */

T(schema.properties.items.minItems === 1, "items minItems 1");
T(schema.properties.items.maxItems === 512, "items maxItems 512");
T(schema.size_limits.max_items === 512, "size_limits.max_items 512");
T(schema.size_limits.max_params_bytes_per_item === 4096, "size_limits max params bytes 4096");
T(schema.size_limits.max_label_chars === 200, "size_limits max label chars 200");
T(schema.size_limits.max_nodes_per_canvas === 64, "size_limits max nodes 64");
T(schema.size_limits.max_edges_per_canvas === 64, "size_limits max edges 64");
T(schema.size_limits.note.indexOf("UTF-8") !== -1, "size_limits note names UTF-8 canonical measurement");
T(itemSchema.properties.params.maxProperties === 12, "params maxProperties 12");
T(itemSchema.properties.params.description.indexOf("4096") !== -1, "params description names 4096 byte limit");

/* ---------- 5. node id pattern ---------- */

const nodeIdRe = new RegExp(itemSchema.allOf[0].then.properties.params.properties.node_id.pattern);
T(nodeIdRe.test("n1"), "n1 valid");
T(nodeIdRe.test("n10"), "n10 valid");
T(!nodeIdRe.test("n0"), "n0 rejected (no leading zero)");
T(!nodeIdRe.test("n01"), "n01 rejected (no leading zero)");
T(!nodeIdRe.test("web"), "walkthrough id 'web' is not a recipe node id");
T(!nodeIdRe.test(""), "empty rejected");

/* ---------- 6. coordinate and label bounds ---------- */

const addNodeP = itemSchema.allOf[0].then.properties.params.properties;
T(addNodeP.x.minimum === 40 && addNodeP.x.maximum === 600, "x in [40, 600]");
T(addNodeP.y.minimum === 40 && addNodeP.y.maximum === 380, "y in [40, 380]");
T(addNodeP.label.minLength === 1 && addNodeP.label.maxLength === 200, "label 1..200 chars");
T(JSON.stringify(addNodeP.type.enum) === JSON.stringify(["collection", "system", "thirdparty", "destruction"]),
  "node type enum has the 4 frozen types");
T(JSON.stringify(itemSchema.allOf[0].then.properties.params.required) ===
  JSON.stringify(["node_id", "type", "x", "y", "label"]), "add_node requires all 5 params");

const connectP = itemSchema.allOf[2].then.properties.params;
T(JSON.stringify(connectP.properties.cat.enum) === JSON.stringify(["contact", "payment", "marketing"]),
  "connect cat enum is contact/payment/marketing");
T(JSON.stringify(connectP.required) === JSON.stringify(["a", "b", "cat"]), "connect requires a, b, cat");

/* ---------- 7. set_retention conditional gate ---------- */

const srBlock = itemSchema.allOf[4];
T(srBlock.if.properties.intent.const === "set_retention", "set_retention branch keyed on intent const");
const gate = srBlock.then.properties.params.allOf[0];
T(JSON.stringify(gate.then.required) === JSON.stringify(["node_id", "record_type", "as_of"]),
  "verify_only branch requires only node_id, record_type, as_of");
T(JSON.stringify(gate.else.required) === JSON.stringify(
  ["node_id", "record_type", "range_min_years", "range_max_years", "statute", "as_of"]),
  "non-verify branch requires the full six-field set");
T(gate.if.properties.verify_only.const === true, "gate tests verify_only const true");
T(gate.if.required.indexOf("verify_only") !== -1, "gate if requires verify_only present");

const srProps = srBlock.then.properties.params.properties;
T(srProps.statute.minLength === 8 && srProps.statute.maxLength === 300, "statute 8..300 chars");
T(typeof srProps.statute.pattern === "string" && srProps.statute.pattern.length > 0, "statute section pattern present");
T(srProps.statute.not && typeof srProps.statute.not.pattern === "string", "statute Law-25 'not' pattern present");
T(srProps.range_min_years.exclusiveMinimum === 0, "range_min_years exclusiveMinimum 0");
T(srProps.range_max_years.exclusiveMinimum === 0, "range_max_years exclusiveMinimum 0");
T(srProps.verify_only.type === "boolean" && srProps.verify_only.default === false,
  "verify_only boolean default false");
T(srProps.anchor && srProps.anchor.maxLength === 120, "anchor optional, max 120 chars");
T(srProps.anchor.description.indexOf("measured from") !== -1, "anchor described as the range origin event");
T(srProps.as_of.pattern === "^\\d{4}-\\d{2}-\\d{2}$", "as_of YYYY-MM-DD pattern");

// The normative statute matcher must reject Law 25 variants and demand a section.
const law25Not = new RegExp(srProps.statute.not.pattern);
for (const v of ["Law 25", "loi 25", "Bill 64", "LPRPSP", "renseignements personnels dans le secteur prive"]) {
  T(law25Not.test(v), "statute 'not' pattern rejects variant: " + v);
}
const secRe = new RegExp(srProps.statute.pattern);
for (const s of ["s. 230(4)(b)", "ss. 34, 35.3", "art. 23", "Article 7", "R. 148(1)", "\u00a7 7"]) {
  T(secRe.test(s), "section pattern accepts: " + s);
}
T(!secRe.test("Income Tax Act"), "section pattern rejects a bare act name");

/* ---------- 8. other intents ---------- */

const runCheck = itemSchema.allOf[7].then.properties.params;
T(JSON.stringify(runCheck.properties.checks.items.enum) ===
  JSON.stringify(["label_coverage", "connectivity", "retention_cited", "edge_categories"]),
  "run_check checks enum has the 4 frozen checks");
T(runCheck.properties.checks.minItems === 1 && runCheck.properties.checks.uniqueItems === true,
  "run_check checks non-empty and unique");
T(itemSchema.allOf[8].then.properties.params.properties.format.const === "xls",
  "export format const xls");
T(itemSchema.allOf[10].then.properties.params.maxProperties === 0, "undo_last params maxProperties 0");
const ffr = itemSchema.allOf[6].then.properties.params;
T(ffr.required.indexOf("reason") !== -1, "flag_for_review requires reason");
T(Array.isArray(ffr.anyOf) && ffr.anyOf.length === 2, "flag_for_review anyOf node_id/item_index");
T(ffr.properties.item_index.minimum === 0 && ffr.properties.item_index.type === "integer",
  "flag_for_review item_index integer >= 0");
const skipP = itemSchema.allOf[9].then.properties.params;
T(skipP.properties.reason.maxLength === 200, "skip_recipe_item reason max 200");
T(skipP.required.indexOf("item_index") !== -1 && skipP.required.indexOf("reason") !== -1,
  "skip_recipe_item requires item_index and reason");

/* ---------- 9. compatibility matrix ---------- */

T(schema.compatibility.matrix["executor 1.x"].supports_recipe.indexOf("1.0.x") !== -1,
  "executor 1.x supports recipe 1.0.x");
T(schema.compatibility.rejection_rule.indexOf("aborts the session") !== -1,
  "rejection rule: unsupported version aborts");
T(schema.compatibility.rejection_rule.indexOf("never executes part of a recipe it cannot fully support") !== -1,
  "rejection rule: no partial execution");

/* ---------- 10. validator behavior: SAMPLE must pass ---------- */

T(validateRecipe(SAMPLE, known) === null, "SAMPLE-RECIPE.json passes validateRecipe");

const mkr = (items) => ({ recipe_id: "t-01", schema_version: "1.0.0", items });

T(validateRecipe(mkr([{ intent: "export", params: { format: "xls" } }]), known) === null,
  "minimal export recipe passes");
T(validateRecipe({ recipe_id: "v", schema_version: "1.0.3",
  items: [{ intent: "export", params: { format: "xls" } }] }, known) === null,
  "schema_version 1.0.3 (patch) accepted by validator");

/* ---------- 11. validator must-fail fixtures ---------- */

function mustFail(recipe, why, match) {
  const err = validateRecipe(recipe, known);
  T(err !== null, "must fail: " + why);
  if (err === null) return;
  T(err.ok === false, "error contract ok:false for " + why);
  T(err.partial_state === null, "error contract partial_state null for " + why);
  T(typeof err.reason === "string" && err.reason.length > 10, "error reason is useful for " + why);
  T(typeof err.recovery_hint === "string" && err.recovery_hint.length > 10,
    "error recovery_hint present for " + why);
  if (match) T(match.test(err.reason), "error reason matches expected text for " + why + ": " + err.reason);
  T(Number.isInteger(err.failed_item_index) || err.failed_item_index === null,
    "failed_item_index is integer or null for " + why);
}

mustFail(mkr([{ intent: "add_nod", params: { node_id: "n1" } }]), "unknown intent", /unknown intent "add_nod"/);
mustFail(mkr([{ intent: "undo_last", params: {} }]), "recovery intent in recipe", /executor-only/);
mustFail(mkr([{ intent: "skip_recipe_item", params: { item_index: 0, reason: "x" } }]), "skip in recipe", /executor-only/);
mustFail(mkr([{ intent: "abort_session", params: { reason: "x" } }]), "abort in recipe", /executor-only/);
mustFail({ recipe_id: "x", schema_version: "2.0.0",
  items: [{ intent: "export", params: { format: "xls" } }] }, "bad schema_version", /2\.0\.0/);
mustFail({ recipe_id: "x", schema_version: "1.0.0", items: [] }, "empty items", /non-empty/);
mustFail({ recipe_id: "bad id!", schema_version: "1.0.0",
  items: [{ intent: "export", params: { format: "xls" } }] }, "bad recipe_id", /recipe_id/);
mustFail({ recipe_id: "x", schema_version: "1.0.0", items: [{ intent: "export", params: { format: "xls" } }],
  surprise: 1 }, "unknown top-level field", /Unknown top-level/);
mustFail(mkr([{ intent: "export", params: { format: "xls" }, extra: 1 }]), "unknown item field", /unknown fields/);
mustFail(mkr([{ intent: "export", params: { format: "xls", extra: 1 } }]), "unknown param", /does not accept param/);
mustFail(mkr([{ intent: "export", params: "xls" }]), "params not an object", /params must be an object/);
mustFail(mkr([{ intent: "add_node", params: { node_id: "n1", type: "system", x: 100, y: 100 } }]),
  "missing required param", /missing required param "label"/);
mustFail(mkr([{ intent: "add_node", params: { node_id: "n0", type: "system", x: 100, y: 100, label: "A" } }]),
  "node_id n0", /node_id must match/);
mustFail(mkr([{ intent: "connect", params: { a: "n1", b: "n1", cat: "contact" } }]),
  "connect self-loop", /self-loop/);
mustFail(mkr([{ intent: "export", params: { format: "csv" } }]), "export csv", /must be "xls"/);
mustFail(mkr([{ intent: "run_check", params: { checks: [] } }]), "run_check empty", /non-empty/);
mustFail(mkr([{ intent: "run_check", params: { checks: ["bogus"] } }]), "run_check unknown", /unknown check/);
mustFail(mkr([{ intent: "flag_for_review", params: { reason: "look" } }]), "flag with no target", /at least one of/);

const bigItem = { intent: "add_node",
  params: { node_id: "n1", type: "system", x: 100, y: 100, label: "x".repeat(5000) } };
mustFail(mkr([bigItem]), "params over 4096 bytes", /4096/);

// errorContract unit checks
const ecRecipe = errorContract(null, "boom");
T(ecRecipe.ok === false && ecRecipe.partial_state === null, "errorContract recipe-level shape");
T(ecRecipe.recovery_hint.indexOf("Fix the recipe JSON") !== -1, "recipe-level recovery hint text");
const ecItem = errorContract(3, "boom");
T(ecItem.failed_item_index === 3 && ecItem.recovery_hint.indexOf("Fix item 3") !== -1,
  "item-level recovery hint names the item");

// determinism: the same invalid recipe fails identically twice
const badOnce = mkr([{ intent: "add_nod", params: { node_id: "n1" } }]);
const e1 = validateRecipe(badOnce, known);
const e2 = validateRecipe(JSON.parse(JSON.stringify(badOnce)), known);
T(e1.reason === e2.reason && e1.failed_item_index === e2.failed_item_index,
  "validation is deterministic across runs");

// knownIntents matches the catalogue: 12 names, 9 authoring + 3 recovery
T(known.size === 12, "knownIntents has 12 entries");
for (const i of AUTHORING.concat(RECOVERY)) T(known.has(i), "knownIntents includes " + i);

process.stderr.write(failed === 0 ? "PASS " + n + " assertions\n" : failed + " FAILURES of " + n + "\n");
if (failed > 0) process.exitCode = 1;
