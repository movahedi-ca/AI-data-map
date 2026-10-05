/* chatbot.test.js - pure-logic tests for the chatbot recipe validator.
   Run with: node chatbot.test.js */
"use strict";
var assert = require("assert");

/* Shim the browser global before the UMD modules load. */
global.self = global;
var S1Templates = require("../executor/js/templates.js");
global.S1Templates = S1Templates;
global.S1Narrate = require("../executor/js/narrate.js");
global.S1I18n = require("../executor/js/i18n.js");
global.S1Executor = { hooks: {} }; /* validator path never touches the executor */
var Chatbot = require("./js/chatbot.js");
var V = Chatbot.pure.validateRecipeText;

var passed = 0;
function ok(cond, name) {
  assert.ok(cond, "FAIL: " + name);
  passed++;
}

/* ---- the Amelie chip vector resolves to the services template ---- */
var amelie = S1Templates.selectTemplate({ size: "11-50", sector: "services", region: "quebec", types: "all" });
ok(amelie && amelie.recipe_id === "t-2-services-qc-all-01", "amelie chips -> t-2-services-qc-all-01");
ok(amelie.items.length === 12, "amelie template has 12 items");

/* ---- all 384 chip vectors are authored ---- */
ok(S1Templates.authoredTemplates().length === 384, "384 authored templates");

/* ---- a template skeleton passes validation ---- */
var r = V(JSON.stringify(amelie), "en");
ok(r.ok === true, "amelie skeleton validates");
ok(r.recipe.recipe_id === "t-2-services-qc-all-01", "validated recipe keeps its id");

/* ---- not JSON ---- */
r = V("{oops", "en");
ok(r.ok === false && r.message.indexOf("not valid JSON") !== -1, "EN: broken JSON rejected plainly");
r = V("{oops", "fr");
ok(r.ok === false && r.message.indexOf("pas du JSON valide") !== -1, "FR: broken JSON rejected plainly");

/* ---- not an object ---- */
r = V("[1,2]", "en");
ok(r.ok === false && r.message.indexOf("must be a JSON object") !== -1, "EN: array rejected");

/* ---- bad recipe_id ---- */
r = V(JSON.stringify({ recipe_id: "bad id!", schema_version: "1.0.0", items: [{ intent: "export", params: { format: "xls" } }] }), "en");
ok(r.ok === false && r.message.indexOf("recipe_id") !== -1, "EN: bad recipe_id rejected");

/* ---- bad schema_version names the version ---- */
var badSchema = JSON.parse(JSON.stringify(amelie));
badSchema.schema_version = "2.0.0";
r = V(JSON.stringify(badSchema), "en");
ok(r.ok === false && r.message.indexOf("2.0.0") !== -1, "EN: unsupported schema names the version");
r = V(JSON.stringify(badSchema), "fr");
ok(r.ok === false && r.message.indexOf("2.0.0") !== -1, "FR: unsupported schema names the version");

/* ---- missing / empty items ---- */
var noItems = { recipe_id: "x-1", schema_version: "1.0.0" };
r = V(JSON.stringify(noItems), "en");
ok(r.ok === false && r.message.indexOf("items list") !== -1, "EN: missing items rejected");
noItems.items = [];
r = V(JSON.stringify(noItems), "en");
ok(r.ok === false && r.message.indexOf("items list") !== -1, "EN: empty items rejected");

/* ---- unknown intent names the intent and the index ---- */
var unk = JSON.parse(JSON.stringify(amelie));
unk.items[2] = { intent: "teleport_node", params: {} };
r = V(JSON.stringify(unk), "en");
ok(r.ok === false && r.message.indexOf("teleport_node") !== -1 && r.message.indexOf("2") !== -1,
  "EN: unknown intent names intent and index");

/* ---- recovery intents are executor-only ---- */
var rec = JSON.parse(JSON.stringify(amelie));
rec.items[2] = { intent: "skip_recipe_item", params: { item_index: 0 } };
r = V(JSON.stringify(rec), "en");
ok(r.ok === false && r.message.indexOf("executor-only") !== -1, "EN: recovery intent rejected");

/* ---- missing param names the param ---- */
var mp = JSON.parse(JSON.stringify(amelie));
delete mp.items[0].params.label;
r = V(JSON.stringify(mp), "en");
ok(r.ok === false && r.message.indexOf("label") !== -1 && r.message.indexOf("0") !== -1,
  "EN: missing param names param and index");

/* ---- set_retention needs a range plus statute, or verify_only ---- */
var sr = {
  recipe_id: "sr-1", schema_version: "1.0.0",
  items: [{ intent: "set_retention", params: { node_id: "n1", record_type: "Tax books" } }]
};
r = V(JSON.stringify(sr), "en");
ok(r.ok === false && r.message.indexOf("verify_only") !== -1, "EN: bare set_retention rejected");
sr.items[0].params.verify_only = true;
r = V(JSON.stringify(sr), "en");
ok(r.ok === true, "verify_only set_retention validates");
delete sr.items[0].params.verify_only;
sr.items[0].params.range_min_years = 6;
sr.items[0].params.range_max_years = 7;
sr.items[0].params.statute = "Some Act, s. 1";
sr.items[0].params.as_of = "2026-10-04";
r = V(JSON.stringify(sr), "en");
ok(r.ok === true, "ranged set_retention validates");

/* ---- run_check needs a checks array ---- */
var rc = {
  recipe_id: "rc-1", schema_version: "1.0.0",
  items: [{ intent: "run_check", params: {} }]
};
r = V(JSON.stringify(rc), "en");
ok(r.ok === false && r.message.indexOf("checks") !== -1, "EN: run_check without checks rejected");

/* ---- FR messages for a couple of representative problems ---- */
r = V(JSON.stringify({ recipe_id: "x-1", schema_version: "1.0.0" }), "fr");
ok(r.ok === false && r.message.indexOf("items") !== -1, "FR: missing items rejected in French");
var frUnk = JSON.parse(JSON.stringify(amelie));
frUnk.items[4] = { intent: "nope", params: {} };
r = V(JSON.stringify(frUnk), "fr");
ok(r.ok === false && r.message.indexOf("nope") !== -1 && r.message.indexOf("4") !== -1,
  "FR: unknown intent names intent and index in French");

/* ---- pure exports surface the contract lists ---- */
ok(Chatbot.pure.CHIP_ORDER.join(",") === "size,sector,region,types", "CHIP_ORDER matches contract 7.1");
ok(Chatbot.pure.AUTHORING_INTENTS.indexOf("flag_for_review") !== -1, "authoring intents listed");
ok(Chatbot.pure.RECOVERY_INTENTS.indexOf("abort_session") !== -1, "recovery intents listed");

console.log("chatbot.test.js: " + passed + " assertions passed");
