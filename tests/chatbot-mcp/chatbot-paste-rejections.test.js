/* chatbot-paste-rejections.test.js - every pasted-recipe failure path rejects
   plainly instead of throwing. Run with: node chatbot-paste-rejections.test.js
   Extends web/chatbot/chatbot.test.js (which covers broken JSON, array
   input, bad recipe_id, bad schema_version, missing/empty items, one
   unknown intent, one recovery intent, one missing param, bare
   set_retention, verify_only, ranged set_retention, run_check checks).
   This file adds: JSON scalars, non-string recipe_id/schema, per-intent
   missing required params, missing/non-object params blocks, wrong
   container types, all recovery intents, unknown intents at several
   indexes, the Law 25 boundary (chatbot accepts structurally, the real MCP
   validator rejects), a no-throw corpus sweep, and FR variants. */
"use strict";
var assert = require("assert");

/* Shim the browser global before the UMD modules load. */
global.self = global;
var S1Templates = require("../../web/executor/js/templates.js");
global.S1Templates = S1Templates;
global.S1Narrate = require("../../web/executor/js/narrate.js");
global.S1I18n = require("../../web/executor/js/i18n.js");
global.S1Executor = { hooks: {} }; /* validator path never touches the executor */
var Chatbot = require("../../web/chatbot/js/chatbot.js");
var V = Chatbot.pure.validateRecipeText;
var Mcp = require("../../mcp/server.js");

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

/* A rejection is {ok:false, message: non-empty plain string}. */
function rejects(text, lang, name, mustMention) {
  var r;
  try {
    r = V(text, lang);
  } catch (e) {
    failures++;
    process.stderr.write("FAIL (threw): " + name + " :: " + (e && e.message) + "\n");
    return null;
  }
  var good = r && r.ok === false && typeof r.message === "string" && r.message.length > 0;
  if (good && mustMention) {
    good = mustMention.every(function (s) { return r.message.indexOf(s) !== -1; });
  }
  if (good) {
    passed++;
  } else {
    failures++;
    process.stderr.write("FAIL: " + name + " :: " + JSON.stringify(r && r.message) + "\n");
  }
  return r;
}

function accepts(text, lang, name) {
  var r = V(text, lang);
  ok(r && r.ok === true, name);
  return r;
}

function recipeWith(items, extra) {
  var r = { recipe_id: "t-1", schema_version: "1.0.0", items: items };
  if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
  return JSON.stringify(r);
}
function item(intent, params) {
  return { intent: intent, params: params === undefined ? {} : params };
}

/* ---- malformed JSON variants ---- */
rejects("{oops", "en", "truncated JSON rejected", ["not valid JSON"]);
rejects("", "en", "empty string rejected", ["not valid JSON"]);
rejects("   ", "en", "whitespace-only rejected", ["not valid JSON"]);
rejects('{"recipe_id": "x",', "en", "cut-off object rejected", ["not valid JSON"]);

/* ---- JSON scalars are not recipes ---- */
rejects("42", "en", "number JSON rejected");
rejects("null", "en", "null JSON rejected");
rejects('"hello"', "en", "string JSON rejected");
rejects("true", "en", "boolean JSON rejected");

/* ---- recipe_id / schema_version type and shape ---- */
rejects(recipeWith([item("export", { format: "xls" })]).replace('"recipe_id":"t-1"', '"recipe_id":42'),
  "en", "non-string recipe_id rejected", ["recipe_id"]);
rejects(recipeWith([item("export", { format: "xls" })]).replace('"recipe_id":"t-1"', '"recipe_id":""'),
  "en", "empty recipe_id rejected", ["recipe_id"]);
rejects(JSON.stringify({ recipe_id: "t-1", schema_version: 100, items: [item("export", { format: "xls" })] }),
  "en", "non-string schema_version rejected");
rejects(JSON.stringify({ recipe_id: "t-1", schema_version: "1.0", items: [item("export", { format: "xls" })] }),
  "en", "truncated schema_version rejected", ["1.0"]);

/* ---- items container problems ---- */
rejects(JSON.stringify({ recipe_id: "t-1", schema_version: "1.0.0", items: "nope" }),
  "en", "string items rejected");
rejects(JSON.stringify({ recipe_id: "t-1", schema_version: "1.0.0", items: null }),
  "en", "null items rejected");
rejects(JSON.stringify({ recipe_id: "t-1", schema_version: "1.0.0", items: [null] }),
  "en", "null item rejected", ["0"]);
rejects(JSON.stringify({ recipe_id: "t-1", schema_version: "1.0.0", items: ["nope"] }),
  "en", "string item rejected", ["0"]);
rejects(JSON.stringify({ recipe_id: "t-1", schema_version: "1.0.0", items: [[]] }),
  "en", "array item rejected", ["0"]);

/* ---- intent problems: missing, non-string, unknown at several indexes ---- */
rejects(recipeWith([{ params: {} }]), "en", "missing intent rejected", ["0"]);
rejects(recipeWith([{ intent: 42, params: {} }]), "en", "non-string intent rejected", ["0"]);
rejects(recipeWith([item("export", { format: "xls" }), item("launch_rocket", {})]),
  "en", "unknown intent at index 1 names intent and index", ["launch_rocket", "1"]);
rejects(recipeWith([item("bogus_action", {})]), "en", "unknown intent at index 0", ["bogus_action", "0"]);

/* ---- every recovery intent is executor-only ---- */
["undo_last", "skip_recipe_item", "abort_session"].forEach(function (ri) {
  rejects(recipeWith([item("export", { format: "xls" }), item(ri, {})]),
    "en", "recovery intent " + ri + " rejected", ["executor-only", "1"]);
});

/* ---- params block problems ---- */
rejects(recipeWith([{ intent: "export" }]), "en", "missing params rejected", ["0"]);
rejects(recipeWith([{ intent: "export", params: null }]), "en", "null params rejected", ["0"]);
rejects(recipeWith([{ intent: "export", params: [] }]), "en", "array params rejected", ["0"]);
rejects(recipeWith([{ intent: "export", params: "xls" }]), "en", "string params rejected", ["0"]);

/* ---- missing required param, one per intent ---- */
var perIntentMissing = [
  ["add_node", { node_id: "n1", type: "system", x: 100, y: 100 }, "label"],
  ["add_collection_point", { node_id: "n1", x: 100, y: 100 }, "label"],
  ["connect", { a: "n1", b: "n2" }, "cat"],
  ["set_field", { node_id: "n1", field: "label" }, "value"],
  ["set_retention", { node_id: "n1" }, "record_type"],
  ["run_check", {}, "checks"],
  ["export", {}, "format"],
  ["confirm_node", {}, "node_id"],
  ["flag_for_review", {}, "reason"]
];
perIntentMissing.forEach(function (tc) {
  rejects(recipeWith([item(tc[0], tc[1])]), "en",
    tc[0] + " missing " + tc[2] + " names param and index", [tc[2], "0"]);
});

/* ---- run_check checks must be an array ---- */
rejects(recipeWith([item("run_check", { checks: "label_coverage" })]), "en",
  "run_check string checks rejected", ["checks"]);
rejects(recipeWith([item("run_check", { checks: null })]), "en",
  "run_check null checks rejected", ["checks"]);

/* ---- set_retention: bare rejected, range and verify_only accepted ---- */
rejects(recipeWith([item("set_retention", { node_id: "n1", record_type: "Tax books" })]),
  "en", "bare set_retention rejected", ["verify_only"]);
accepts(recipeWith([item("set_retention", { node_id: "n1", record_type: "Tax books", verify_only: true })]),
  "en", "verify_only set_retention accepted");
accepts(recipeWith([item("set_retention", {
  node_id: "n1", record_type: "Tax books",
  range_min_years: 6, range_max_years: 7, statute: "Some Act, s. 1", as_of: "2026-10-04"
})]), "en", "ranged set_retention accepted");

/* ---- Law 25 boundary: the chatbot checks structure only; statute
        semantics (no numerical periods sourced to Law 25) belong to the
        real recipe validator, which must reject this block. ---- */
var law25 = {
  recipe_id: "law25-1", schema_version: "1.0.0",
  items: [item("set_retention", {
    node_id: "n1", record_type: "Tax books",
    range_min_years: 6, range_max_years: 7,
    statute: "Law 25, s. 12", as_of: "2026-10-04"
  })]
};
var chatLaw25 = V(JSON.stringify(law25), "en");
ok(chatLaw25.ok === true, "chatbot accepts ranged Law 25 block structurally (semantics are the MCP layer's job)");
var mcpLaw25 = Mcp.validateRecipe(JSON.parse(JSON.stringify(law25)), Mcp.knownIntents());
ok(mcpLaw25 !== null && mcpLaw25.ok === false && /Law 25/.test(mcpLaw25.reason),
  "real MCP validator rejects Law 25 as the source of a numerical retention period");
ok(mcpLaw25 !== null && mcpLaw25.failed_item_index === 0, "Law 25 rejection points at item 0");

/* ---- wrong-type boundary the chatbot does not police: format as an array
        passes the chatbot (presence-only check) but the real MCP validator
        rejects it. ---- */
var arrayFormat = {
  recipe_id: "af-1", schema_version: "1.0.0",
  items: [item("export", { format: ["xls"] })]
};
ok(V(JSON.stringify(arrayFormat), "en").ok === true,
  "chatbot accepts export with array format (presence-only check)");
var mcpArrayFormat = Mcp.validateRecipe(JSON.parse(JSON.stringify(arrayFormat)), Mcp.knownIntents());
ok(mcpArrayFormat !== null && mcpArrayFormat.ok === false,
  "real MCP validator rejects export with array format");

/* ---- valid shapes still pass ---- */
accepts(recipeWith([item("export", { format: "xls" })]), "en", "minimal valid recipe accepted");
accepts(recipeWith([item("add_node", { node_id: "n1", type: "system", x: 100, y: 100, label: "Core" }),
  item("connect", { a: "n1", b: "n2", cat: "contact" })], { name: "Named recipe" }),
  "en", "multi-item named recipe accepted");

/* ---- no-throw sweep: a corpus of hostile inputs never throws ---- */
var corpus = [
  "{", "}", "[}", "[[[[", "{}}", "", " ", "\n\t",
  "null", "0", "-1", "1e999", "NaN", "Infinity", "undefined",
  "[]", "[1]", "{}", '{"a":}', '{"a":1,}',
  JSON.stringify({}), JSON.stringify({ recipe_id: 1 }),
  JSON.stringify({ recipe_id: "x", schema_version: "1.0.0", items: [{ intent: null, params: null }] }),
  "\u0000", "{�"
];
var threw = 0;
corpus.forEach(function (text, i) {
  try {
    var r = V(text, "en");
    if (!(r && r.ok === false && typeof r.message === "string")) {
      failures++;
      process.stderr.write("FAIL: corpus[" + i + "] did not reject plainly\n");
    } else {
      passed++;
    }
  } catch (e) {
    threw++;
    failures++;
    process.stderr.write("FAIL: corpus[" + i + "] threw: " + (e && e.message) + "\n");
  }
});
ok(threw === 0, "no corpus input threw (" + corpus.length + " inputs)");

/* ---- FR variants of representative rejections ---- */
rejects(recipeWith([item("export", { format: "xls" })]).replace('"recipe_id":"t-1"', '"recipe_id":"bad id"'),
  "fr", "FR: bad recipe_id rejected");
rejects(recipeWith([item("add_node", { node_id: "n1" })]), "fr",
  "FR: missing param names param and index", ["type", "0"]);
rejects(recipeWith([item("undo_last", {})]), "fr", "FR: recovery intent rejected");

/* ---- pure contract surface ---- */
ok(Chatbot.pure.AUTHORING_INTENTS.length === 9, "9 authoring intents exported");
ok(Chatbot.pure.RECOVERY_INTENTS.length === 3, "3 recovery intents exported");
ok(Chatbot.pure.AUTHORING_INTENTS.indexOf("set_retention") !== -1, "set_retention is an authoring intent");

if (failures === 0) {
  console.log("PASS " + passed + " assertions");
} else {
  console.log("FAIL " + failures + " of " + (passed + failures) + " assertions");
  process.exitCode = 1;
}
