"use strict";
/*
 * action-catalogue.test.js: frozen action catalogue contracts.
 * Run: node tests/specs/action-catalogue.test.js
 *
 * Covers: catalogue document invariants (12 actions, mutating default,
 * pause/skip/undo semantics, abort seal, anchor field, seq monotonicity),
 * the idempotency key mechanism with its worked example, and the normative
 * statute matcher (section pattern + Law 25 variants) driven through the
 * real MCP validator with positive and must-fail fixtures.
 */

global.self = global;

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const cat = JSON.parse(fs.readFileSync(path.join(REPO, "specs", "action-catalogue.json"), "utf8"));
const { validateRecipe, knownIntents } = require(path.join(REPO, "mcp", "server.js"));
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
function byName(name) {
  return cat.actions.filter((a) => a.name === name)[0];
}

/* ---------- 1. catalogue shape ---------- */

T(cat.catalogue_version === "1.0.0", "catalogue_version 1.0.0");
T(cat.actions.length === 12, "12 actions in the catalogue");
const names = cat.actions.map((a) => a.name);
T(new Set(names).size === 12, "action names unique");
for (const nm of ["add_node", "add_collection_point", "connect", "set_field", "set_retention",
  "confirm_node", "flag_for_review", "run_check", "export",
  "skip_recipe_item", "undo_last", "abort_session"]) {
  T(names.indexOf(nm) !== -1, "catalogue includes " + nm);
}
for (const a of cat.actions) {
  T(typeof a.name === "string", a.name + " has a name");
  T(Array.isArray(a.preconditions), a.name + " has preconditions");
  T(Array.isArray(a.effects) && a.effects.length > 0, a.name + " has effects");
  T(typeof a.idempotency === "string" && a.idempotency.length > 0, a.name + " documents idempotency");
  T(typeof a.undo_inverse === "string" && a.undo_inverse.length > 0, a.name + " documents undo_inverse");
  T(typeof a.parameters === "object", a.name + " documents parameters");
}
T(cat.description.indexOf("recovery actions") !== -1, "description names the recovery actions");
T(cat.description.indexOf("mutating: true") !== -1, "description states the mutating default");

/* ---------- 2. mutating default ---------- */

function mutating(a) { return ("mutating" in a) ? a.mutating : cat.mutating_default; }
T(cat.mutating_default === true, "mutating_default true");
for (const nm of ["add_node", "add_collection_point", "connect", "set_field", "set_retention",
  "undo_last", "flag_for_review"]) {
  T(mutating(byName(nm)) === true, nm + " is mutating (default)");
}
for (const nm of ["confirm_node", "run_check", "export", "skip_recipe_item", "abort_session"]) {
  T(mutating(byName(nm)) === false, nm + " explicitly non-mutating");
}

/* ---------- 3. pause/skip/undo semantics ---------- */

const flag = byName("flag_for_review");
T(flag.effects.join(" ").indexOf("frozen") !== -1, "flag: item_index frozen while a flag is open");
T(flag.effects.join(" ").indexOf("undo_last") !== -1, "flag: reduced set includes undo_last");
T(flag.effects.join(" ").indexOf("abort_session") !== -1, "flag: reduced set includes abort_session");
T(flag.effects.join(" ").indexOf("does not advance") !== -1, "flag: the recipe does not advance");
T(flag.effects.join(" ").indexOf("human out-of-band") !== -1, "flag cleared by human out-of-band via review UI");
T(flag.undo_inverse === "Clear the flag.", "flag undo_inverse clears the flag");
T(flag.parameters.reason.type.indexOf("1-500") !== -1, "flag reason 1-500 chars");

const skip = byName("skip_recipe_item");
T(skip.undo_inverse.indexOf("Unmark the skip") !== -1, "skip undo_inverse unmarks the skip");
T(skip.preconditions.join(" ").indexOf("current item_index") !== -1,
  "skip precondition: only the current item may be skipped");
T(skip.effects.join(" ").indexOf("advances item_index by one") !== -1, "skip advances item_index by one");
T(skip.parameters.item_index.type.indexOf("must equal the current item_index") !== -1,
  "skip item_index must equal current");

const undo = byName("undo_last");
T(JSON.stringify(undo.parameters) === "{}", "undo_last takes no parameters");
T(undo.preconditions.join(" ").indexOf("At least one mutating action") !== -1,
  "undo precondition: at least one applied mutating action");
T(undo.effects.join(" ").indexOf("tombstone") !== -1, "undone key moves to the tombstone set");
T(undo.effects.join(" ").indexOf("never the first undo") !== -1,
  "second consecutive undo undoes the next-earlier mutating action, never the first undo");
T(undo.undo_inverse.indexOf("no re-apply action") !== -1, "undo undo_inverse: no re-apply in Phase 0");
T(undo.idempotency.indexOf("Safe to replay") !== -1 &&
  undo.idempotency.indexOf("instead of undoing a second action") !== -1,
  "replaying an undo_last key returns the recorded result instead of undoing a second action");

/* ---------- 4. abort seal ---------- */

const abort = byName("abort_session");
T(abort.preconditions.length === 0, "abort has no preconditions (available in every state)");
T(abort.effects.join(" ").indexOf("terminates immediately") !== -1, "abort terminates immediately");
T(abort.effects.join(" ").indexOf("sealed with the abort reason") !== -1, "abort seals the snapshot with the reason");
T(abort.undo_inverse === "None. A terminated session is never resumed.",
  "abort undo_inverse: never resumed");
T(abort.idempotency.indexOf("stays terminated") !== -1, "replaying abort keeps the session terminated");

/* ---------- 5. statute_validation action ---------- */

const sv = cat.statute_validation;
T(sv.description.indexOf("case-insensitively") !== -1, "matcher applied case-insensitively (lowercase first)");
T(sv.law25_variants.length === 6, "6 Law 25 variants listed");
for (const v of ["law 25", "loi 25", "bill 64", "lprpsp",
  "modernisant des dispositions legislatives en matiere de protection des renseignements personnels",
  "renseignements personnels dans le secteur prive"]) {
  T(sv.law25_variants.indexOf(v) !== -1, "variant listed: " + v.slice(0, 24));
}
T(sv.law25_rule.indexOf("rejected as the source of a number") !== -1, "law25_rule: rejected as source of a number");
T(typeof sv.section_pattern === "string" && sv.section_pattern.length > 0, "section_pattern present");
T(sv.section_rule.indexOf("bare act name") !== -1, "section_rule rejects a bare act name");

const secRe = new RegExp(sv.section_pattern);
for (const s of ["s. 230(4)(b)", "ss. 34, 35.3", "art. 23", "\u00a7 7"]) {
  T(secRe.test(s), "catalogue section pattern accepts: " + s);
}
T(!secRe.test("Income Tax Act"), "catalogue section pattern rejects bare act name");

/* ---------- 6. anchor field and seq monotonicity ---------- */

const sr = byName("set_retention");
T("anchor" in sr.parameters, "set_retention documents the anchor parameter");
T(sr.parameters.anchor.description.indexOf("after death") !== -1, "anchor examples: after death");
T(sr.effects.join(" ").indexOf("measured from the anchor event") !== -1,
  "anchor effect: range measured from the anchor event");
T(sr.preconditions.join(" ").indexOf("range_min_years < range_max_years") !== -1,
  "set_retention precondition: min < max (single number rejected)");
T(sr.preconditions.join(" ").indexOf("Law 25 is never accepted") !== -1,
  "set_retention precondition: Law 25 never accepted as the source of a number");
T(sr.parameters.as_of.type.indexOf("YYYY-MM-DD") !== -1, "as_of YYYY-MM-DD");
T(sr.parameters.as_of.type.indexOf("not in the future") !== -1, "as_of not in the future");

const addNode = byName("add_node");
T(addNode.effects.join(" ").indexOf("never decrements") !== -1, "guide seq monotonic: never decrements");
T(addNode.effects.join(" ").indexOf("undone ids leave gaps") !== -1, "undone ids leave gaps in the sequence");
T(addNode.preconditions.join(" ").indexOf("no gaps") !== -1, "add_node precondition: ids ascend with no gaps");
T(addNode.parameters.node_id.type.indexOf("^n[1-9]") !== -1, "add_node node_id canonical pattern");
T(addNode.parameters.x.type.indexOf("40-600") !== -1, "add_node x 40-600");
T(addNode.parameters.y.type.indexOf("40-380") !== -1, "add_node y 40-380");

/* ---------- 7. idempotency mechanism ---------- */

const idem = cat.idempotency_mechanism;
T(idem.definition.indexOf("U+0000") !== -1, "key joins fields with U+0000");
T(idem.definition.indexOf("SHA-256") !== -1, "key is a SHA-256 hex digest");
T(idem.example.indexOf("cafe-nord-sample-01") !== -1, "worked example uses the sample recipe");
T(idem.session_scope.indexOf("per-session") !== -1, "keys are per-session");

function idemKey(recipeId, itemIndex, actionName) {
  return crypto.createHash("sha256")
    .update(recipeId + "\0" + String(itemIndex) + "\0" + actionName, "utf8").digest("hex");
}
const k1 = idemKey("cafe-nord-sample-01", 3, "connect");
T(/^[0-9a-f]{64}$/.test(k1), "idempotency key is 64 lowercase hex");
T(idemKey("cafe-nord-sample-01", 3, "connect") === k1, "key is deterministic for identical inputs");
T(idemKey("cafe-nord-sample-01", 3, "export") !== k1, "key changes with the action name");
T(idemKey("cafe-nord-sample-01", 4, "connect") !== k1, "key changes with the item index");
T(idemKey("other-recipe", 3, "connect") !== k1, "key changes with the recipe id");

/* ---------- 8. statute matcher behavior through the real validator ---------- */

function retItem(p) {
  return { intent: "set_retention", params: Object.assign(
    { node_id: "n1", record_type: "Tax records", as_of: "2026-10-04" }, p) };
}
const base = { range_min_years: 6, range_max_years: 7 };

// every Law 25 variant must fail as the source of a number
for (const v of sv.law25_variants) {
  const statute = "Some act (" + v + "), s. 23";
  const err = validateRecipe({ recipe_id: "law25-" + v.length, schema_version: "1.0.0",
    items: [retItem(Object.assign({ statute }, base))] }, known);
  T(err !== null && /Law 25 sets no retention periods/.test(err.reason),
    "Law 25 variant rejected as source of a number: " + v.slice(0, 30));
}
// case-insensitivity: uppercase variant also fails
const errUp = validateRecipe({ recipe_id: "law25-up", schema_version: "1.0.0",
  items: [retItem(Object.assign({ statute: "LAW 25, S. 23" }, base))] }, known);
T(errUp !== null && /Law 25 sets no retention periods/.test(errUp.reason),
  "uppercase LAW 25 rejected (case-insensitive matcher)");

// positive: real statutes with sections pass
const goodStatutes = [
  "Income Tax Act, R.S.C. 1985, c. 1 (5th Supp.), s. 230(4)(b)",
  "Loi sur l'administration fiscale, RLRQ, c. A-6.002, ss. 34, 35.3",
  "Employment Insurance Act, S.C. 1996, c. 23, s. 87(3)",
  "Loi sur les archives, RLRQ, c. A-21.1, s. 7",
  "Proceeds of Crime (Money Laundering) and Terrorist Financing Regulations, SOR/2002-184, s. 148(1)"
];
for (const s of goodStatutes) {
  const err = validateRecipe({ recipe_id: "good-stat", schema_version: "1.0.0",
    items: [retItem(Object.assign({ statute: s }, base))] }, known);
  T(err === null, "statute with act and section passes: " + s.slice(0, 40));
}

// must-fail: bare act name (no section)
const errBare = validateRecipe({ recipe_id: "bare", schema_version: "1.0.0",
  items: [retItem(Object.assign({ statute: "Income Tax Act" }, base))] }, known);
T(errBare !== null && /act and a section/.test(errBare.reason), "bare act name rejected");

// anchor passes alongside a cited range
const errAnchor = validateRecipe({ recipe_id: "anch", schema_version: "1.0.0",
  items: [retItem(Object.assign({ statute: "Loi sur les archives, RLRQ, c. A-21.1, s. 7",
    range_min_years: 5, range_max_years: 6, anchor: "after death" }))] }, known);
T(errAnchor === null, "anchor plus cited range passes");

// run_check non-mutating per catalogue, enforced by validator accept
const errRun = validateRecipe({ recipe_id: "rc", schema_version: "1.0.0",
  items: [{ intent: "run_check", params: { checks: ["label_coverage"] } }] }, known);
T(errRun === null, "run_check accepted by the validator");

// catalogue intent names and MCP known intents agree
for (const nm of names) T(known.has(nm), "MCP knownIntents includes catalogue action " + nm);
T(known.size === names.length, "MCP knownIntents count matches catalogue count");

process.stderr.write(failed === 0 ? "PASS " + n + " assertions\n" : failed + " FAILURES of " + n + "\n");
if (failed > 0) process.exitCode = 1;
