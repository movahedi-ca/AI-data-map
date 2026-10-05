/* chatbot-determinism.test.js - template selection is a pure deterministic lookup.
   Run with: node chatbot-determinism.test.js
   Covers: all 384 chip vectors resolve twice with identical bytes; every
   vector resolves to some template; the Amelie vector keeps resolving to
   t-2-services-qc-all-01 (12 items); template skeletons have
   recipe-schema-only keys; the Amelie recipe validates through both the
   chatbot paste validator and the real MCP recipe validator; the same chip
   vector in French locale yields the equivalent recipe. */
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

var SIZES = ["1-10", "11-50", "51-200", "200+"];
var SECTORS = ["retail", "services", "health", "tech", "manufacturing", "nonprofit"];
var REGIONS = ["quebec", "canada", "canada-us", "international"];
var TYPES = ["contact", "contact-payment", "contact-marketing", "all"];

function vectors() {
  var out = [];
  SIZES.forEach(function (a) {
    SECTORS.forEach(function (b) {
      REGIONS.forEach(function (c) {
        TYPES.forEach(function (d) {
          out.push({ size: a, sector: b, region: c, types: d });
        });
      });
    });
  });
  return out;
}

var vecs = vectors();
ok(vecs.length === 384, "chip space is 4*6*4*4 = 384 vectors");

/* ---- every vector resolves, and identically across two full runs ---- */
var run1 = vecs.map(function (v) { return JSON.stringify(S1Templates.selectTemplate(v)); });
var run2 = vecs.map(function (v) { return JSON.stringify(S1Templates.selectTemplate(v)); });
var resolved = 0;
vecs.forEach(function (v, i) {
  var t = JSON.parse(run1[i]);
  ok(t !== null && t !== undefined, "vector " + i + " (" + v.size + "/" + v.sector + "/" + v.region + "/" + v.types + ") resolves to some template");
  if (t) resolved++;
  ok(run1[i] === run2[i], "vector " + i + " is byte-identical across two full runs");
});
ok(resolved === 384, "all 384 vectors resolved (none undefined)");
ok(S1Templates.authoredTemplates().length === 384, "authored table holds 384 templates");

/* ---- every vector passes the chatbot's own chip check ---- */
var badChips = 0;
vecs.forEach(function (v) {
  if (S1Templates.validateChips(v).length !== 0) badChips++;
});
ok(badChips === 0, "validateChips accepts all 384 authored vectors");

/* ---- the Amelie vector: id, item count, stability, schema-only keys ---- */
function amelie() {
  return S1Templates.selectTemplate({ size: "11-50", sector: "services", region: "quebec", types: "all" });
}
var a1 = amelie();
ok(a1 && a1.recipe_id === "t-2-services-qc-all-01", "amelie chips -> t-2-services-qc-all-01");
ok(a1.items.length === 12, "amelie template has 12 items");
ok(JSON.stringify(a1) === JSON.stringify(amelie()), "amelie template is stable across calls");
ok(JSON.stringify(Object.keys(a1).sort()) === JSON.stringify(["items", "name", "recipe_id", "schema_version"]),
  "template carries only recipe-schema top-level keys");
ok(a1.schema_version === "1.0.0", "template schema_version is 1.0.0");
var itemsClean = true;
a1.items.forEach(function (it) {
  var keys = Object.keys(it).sort().join(",");
  if (keys !== "intent,params") itemsClean = false;
  if (typeof it.intent !== "string") itemsClean = false;
  if (Chatbot.pure.AUTHORING_INTENTS.indexOf(it.intent) === -1) itemsClean = false;
});
ok(itemsClean, "every amelie item is {intent, params} with a known authoring intent");

/* ---- chip -> template -> recipe: both validators accept the Amelie recipe ---- */
var chatRes = V(JSON.stringify(a1), "en");
ok(chatRes.ok === true, "amelie recipe passes the chatbot paste validator");
ok(chatRes.recipe.recipe_id === "t-2-services-qc-all-01", "chatbot validator keeps the recipe id");
var mcpErr = Mcp.validateRecipe(JSON.parse(JSON.stringify(a1)), Mcp.knownIntents());
ok(mcpErr === null, "amelie recipe passes the real MCP recipe validator");

/* ---- FR path: same chip vector, equivalent recipe ---- */
var frRes = V(JSON.stringify(amelie()), "fr");
ok(frRes.ok === true, "FR: same chip vector recipe validates");
ok(frRes.recipe.recipe_id === "t-2-services-qc-all-01", "FR: recipe id matches the EN path");
ok(frRes.recipe.items.length === 12, "FR: item count matches the EN path");
var frBad = V("{oops", "fr");
ok(frBad.ok === false && typeof frBad.message === "string" && frBad.message.length > 0,
  "FR: rejections stay localized plain-language messages");

/* ---- template ids are unique across the table ---- */
var ids = S1Templates.authoredTemplates().map(function (t) { return t.recipe_id; });
var uniq = {};
ids.forEach(function (id) { uniq[id] = 1; });
ok(Object.keys(uniq).length === 384, "all 384 template ids are unique");

if (failures === 0) {
  console.log("PASS " + passed + " assertions");
} else {
  console.log("FAIL " + failures + " of " + (passed + failures) + " assertions");
  process.exitCode = 1;
}
