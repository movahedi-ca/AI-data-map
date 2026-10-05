"use strict";
/*
 * validators.test.js: the two real recipe validators side by side.
 * Run: node tests/specs/validators.test.js
 *
 * Covers: SAMPLE-RECIPE.json passes both the MCP validator
 * (mcp/server.js validateRecipe) and the chatbot's pure structural gate
 * (web/chatbot/js/chatbot.js Chatbot.pure.validateRecipeText); must-fail
 * fixtures through both; the documented strength difference between the
 * two gates (chatbot is structural, the MCP tool enforces the statute
 * matcher); chatbot i18n error strings in EN and FR.
 */

global.self = global;

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const SAMPLE_TEXT = fs.readFileSync(path.join(REPO, "specs", "SAMPLE-RECIPE.json"), "utf8");
const SAMPLE = JSON.parse(SAMPLE_TEXT);

const i18n = require(path.join(REPO, "web", "executor", "js", "i18n.js"));
global.S1I18n = { strings: i18n.strings };
const cb = require(path.join(REPO, "web", "chatbot", "js", "chatbot.js"));
const { validateRecipe, knownIntents } = require(path.join(REPO, "mcp", "server.js"));
const known = knownIntents();
const vtxt = cb.pure.validateRecipeText;

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

/* ---------- 1. sample passes both validators ---------- */

T(validateRecipe(SAMPLE, known) === null, "SAMPLE passes the MCP validator");
const sres = vtxt(SAMPLE_TEXT, "en");
T(sres.ok === true, "SAMPLE passes the chatbot validator");
T(sres.ok && sres.recipe.recipe_id === "cafe-nord-sample-01", "chatbot returns the parsed recipe id");
T(sres.ok && sres.recipe.items.length === 8, "chatbot returns all 8 sample items");
T(sres.ok && sres.recipe.items[5].intent === "set_retention", "sample item 5 is set_retention");
T(sres.ok && sres.recipe.items[5].params.statute.indexOf("ss. 34, 35.3") !== -1,
  "sample retention cites the statute and section");

// chatbot intent lists: 9 authoring + 3 recovery, matching the frozen vocabulary
T(cb.pure.AUTHORING_INTENTS.length === 9, "chatbot authoring intents: 9");
T(cb.pure.RECOVERY_INTENTS.length === 3, "chatbot recovery intents: 3");
T(cb.pure.CHIP_ORDER.length === 4, "chatbot asks 4 chip questions in order");
for (const i of ["add_node", "set_retention", "run_check", "export", "confirm_node", "flag_for_review"]) {
  T(cb.pure.AUTHORING_INTENTS.indexOf(i) !== -1, "chatbot authoring includes " + i);
}
for (const i of ["undo_last", "skip_recipe_item", "abort_session"]) {
  T(cb.pure.RECOVERY_INTENTS.indexOf(i) !== -1, "chatbot recovery includes " + i);
  T(known.has(i), "MCP known intents include recovery action " + i);
}

/* ---------- 2. chatbot must-fail fixtures (structural gate) ---------- */

function chatMustFail(obj, why, match) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj);
  const res = vtxt(text, "en");
  T(res.ok === false, "chatbot must fail: " + why);
  if (res.ok !== false) return;
  T(typeof res.message === "string" && res.message.length > 0, "chatbot error is a non-empty message: " + why);
  if (match) T(match.test(res.message), "chatbot message matches for " + why + ": " + res.message.slice(0, 80));
}

chatMustFail("this is not json", "non-JSON input", /not valid JSON/);
chatMustFail("[1,2]", "JSON array instead of object", /JSON object/);
chatMustFail("123", "bare value instead of object", /JSON object/);
chatMustFail({ schema_version: "1.0.0", items: [] }, "missing recipe_id", /recipe_id/);
chatMustFail({ recipe_id: "bad id!", schema_version: "1.0.0", items: [] }, "bad recipe_id", /recipe_id/);
chatMustFail({ recipe_id: "x", schema_version: "2.0.0", items: [] }, "bad schema_version", /2\.0\.0/);
chatMustFail({ recipe_id: "x", schema_version: "1.0.0", items: [] }, "empty items", /non-empty/);
chatMustFail({ recipe_id: "x", schema_version: "1.0.0",
  items: [{ intent: "add_nod", params: { node_id: "n1" } }] }, "unknown intent", /add_nod/);
chatMustFail({ recipe_id: "x", schema_version: "1.0.0",
  items: [{ intent: "abort_session", params: { reason: "r" } }] }, "recovery intent", /abort_session/);
chatMustFail({ recipe_id: "x", schema_version: "1.0.0",
  items: [{ intent: "export", params: "xls" }] }, "params not an object", /params/);
chatMustFail({ recipe_id: "x", schema_version: "1.0.0",
  items: [{ intent: "connect", params: { a: "n1", b: "n2" } }] }, "missing param", /cat/);
chatMustFail({ recipe_id: "x", schema_version: "1.0.0",
  items: [{ intent: "run_check", params: { checks: "label_coverage" } }] }, "run_check checks not array", /checks/);
chatMustFail({ recipe_id: "x", schema_version: "1.0.0",
  items: [{ intent: "set_retention", params: { node_id: "n1", record_type: "Tax" } }] },
  "set_retention without range and without verify_only", /retention range/);
chatMustFail({ recipe_id: "x", schema_version: "1.0.0",
  items: ["nope"] }, "item not an object", /Step 0/);

// chatbot positive: verify_only structural gate
const chatVerify = vtxt(JSON.stringify({ recipe_id: "v", schema_version: "1.0.0",
  items: [{ intent: "set_retention", params: { node_id: "n1", record_type: "Tax", verify_only: true } }] }), "en");
T(chatVerify.ok === true, "chatbot accepts verify_only set_retention structurally");
const chatRange = vtxt(JSON.stringify({ recipe_id: "v", schema_version: "1.0.0",
  items: [{ intent: "set_retention", params: { node_id: "n1", record_type: "Tax",
    range_min_years: 6, range_max_years: 7, statute: "Income Tax Act, s. 230(4)(b)", as_of: "2026-10-04" } }] }), "en");
T(chatRange.ok === true, "chatbot accepts a full retention item structurally");

/* ---------- 3. documented strength difference between the gates ---------- */

// The chatbot is a structural gate only: it does not enforce the statute
// matcher or as_of. The MCP tool is the enforcement point. Assert both
// behaviors so a future tightening of either is caught deliberately.
const law25Item = [{ intent: "set_retention", params: { node_id: "n1", record_type: "Tax",
  range_min_years: 6, range_max_years: 7, statute: "Law 25, s. 23", as_of: "2026-10-04" } }];
const chatLaw = vtxt(JSON.stringify({ recipe_id: "l", schema_version: "1.0.0", items: law25Item }), "en");
T(chatLaw.ok === true, "chatbot structural gate does NOT reject Law 25 (documented difference)");
const mcpLaw = validateRecipe({ recipe_id: "l", schema_version: "1.0.0", items: law25Item }, known);
T(mcpLaw !== null && /Law 25 sets no retention periods/.test(mcpLaw.reason),
  "MCP validator DOES reject Law 25 as the source of a number");

const noAsOf = [{ intent: "set_retention", params: { node_id: "n1", record_type: "Tax",
  range_min_years: 6, range_max_years: 7, statute: "Income Tax Act, s. 230(4)(b)" } }];
const chatNoAsOf = vtxt(JSON.stringify({ recipe_id: "d", schema_version: "1.0.0", items: noAsOf }), "en");
T(chatNoAsOf.ok === true, "chatbot does not require as_of (documented difference)");
const mcpNoAsOf = validateRecipe({ recipe_id: "d", schema_version: "1.0.0", items: noAsOf }, known);
T(mcpNoAsOf !== null && /as_of/.test(mcpNoAsOf.reason), "MCP validator requires as_of");

/* ---------- 4. chatbot error strings: EN and FR ---------- */

const SEN = i18n.strings("en");
const SFR = i18n.strings("fr");
for (const k of ["chatErrNotJson", "chatErrNotObject", "chatErrBadRecipeId", "chatErrBadSchema",
  "chatErrNoItems", "chatErrUnknownIntent", "chatErrRecoveryIntent", "chatErrMissingParam",
  "chatErrRetentionRange"]) {
  T(typeof SEN[k] === "string" && SEN[k].length > 0, "EN string present: " + k);
  T(typeof SFR[k] === "string" && SFR[k].length > 0, "FR string present: " + k);
}
const frRes = vtxt("123", "fr");
T(frRes.ok === false && frRes.message === SFR.chatErrNotObject, "FR error message returned for fr lang");
const enRes = vtxt("123", "en");
T(enRes.ok === false && enRes.message === SEN.chatErrNotObject, "EN error message returned for en lang");
T(SEN.chatErrNotObject !== SFR.chatErrNotObject, "EN and FR messages differ (localized)");

/* ---------- 5. MCP error contract shape on a representative failure ---------- */

const bad = { recipe_id: "x", schema_version: "1.0.0",
  items: [{ intent: "export", params: { format: "xls" } },
          { intent: "connect", params: { a: "n1", b: "n1", cat: "contact" } }] };
const merr = validateRecipe(bad, known);
T(merr.ok === false, "error contract ok:false");
T(merr.failed_item_index === 1, "error contract names failed item 1");
T(merr.reason.indexOf("self-loop") !== -1, "error contract reason names the rule");
T(merr.partial_state === null, "error contract partial_state null");
T(typeof merr.recovery_hint === "string" && merr.recovery_hint.indexOf("item 1") !== -1,
  "error contract recovery hint names the item");
// the first failing item wins; nothing past it is reported
T(merr.failed_item_index !== 0, "failure reported at the failing item, not earlier");

process.stderr.write(failed === 0 ? "PASS " + n + " assertions\n" : failed + " FAILURES of " + n + "\n");
if (failed > 0) process.exitCode = 1;
