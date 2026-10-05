/* mcp-asof-boundary.test.js - regression test for the isPastOrToday off-by-half-day bug.
   Run with: node tests/chatbot-mcp/mcp-asof-boundary.test.js
   Background: isPastOrToday parsed the date at noon UTC but compared it against
   UTC midnight, so as_of = today was always rejected. 381 of the 384 authored
   templates carry as_of = their authoring date and failed MCP validation until
   the fix (normalize both sides to UTC midnight before comparing). */
"use strict";
var assert = require("assert");

global.self = global;
var S = require("../../mcp/server.js");
var known = S.knownIntents();

var passed = 0;
function ok(cond, name) {
  assert.ok(cond, "FAIL: " + name);
  passed++;
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}
var now = new Date();
var today = ymd(now);
var yesterday = ymd(new Date(now.getTime() - 86400000));
var tomorrow = ymd(new Date(now.getTime() + 86400000));

function recipeWithAsOf(asOf) {
  return {
    recipe_id: "t-asof-boundary-01",
    schema_version: "1.0.0",
    name: "as_of boundary probe",
    items: [
      {
        intent: "set_retention",
        params: {
          node_id: "n1",
          record_type: "customer records",
          as_of: asOf,
          verify_only: true,
          statute: "Taxation Act, s. 230"
        }
      }
    ]
  };
}

/* ---- today is accepted (the regression) ---- */
ok(S.validateRecipe(recipeWithAsOf(today), known) === null,
  "as_of = today (" + today + ") passes validation");

/* ---- yesterday is accepted ---- */
ok(S.validateRecipe(recipeWithAsOf(yesterday), known) === null,
  "as_of = yesterday (" + yesterday + ") passes validation");

/* ---- tomorrow is rejected ---- */
var rFuture = S.validateRecipe(recipeWithAsOf(tomorrow), known);
ok(rFuture && rFuture.ok === false && /as_of/.test(rFuture.reason),
  "as_of = tomorrow (" + tomorrow + ") fails with an as_of reason");

/* ---- malformed dates are rejected ---- */
var rBad = S.validateRecipe(recipeWithAsOf("2026-13-99"), known);
ok(rBad && rBad.ok === false, "impossible date 2026-13-99 fails");
var rFmt = S.validateRecipe(recipeWithAsOf("10/05/2026"), known);
ok(rFmt && rFmt.ok === false, "non-ISO format fails");

/* ---- all 384 authored templates validate through the MCP gate ---- */
var templates = require("../../data/templates.json");
var arr = Object.values(templates.templates);
ok(arr.length === 384, "384 authored templates present");
var bad = [];
arr.forEach(function (t) {
  var recipe = { recipe_id: t.recipe_id, schema_version: t.schema_version, name: t.name, items: t.items };
  var r = S.validateRecipe(recipe, known);
  if (r) bad.push(t.recipe_id + " :: " + r.reason);
});
ok(bad.length === 0, "all 384 templates pass MCP validateRecipe" +
  (bad.length ? " (failures: " + bad.slice(0, 3).join(" | ") + ")" : ""));

console.log("PASS " + passed + " assertions");
