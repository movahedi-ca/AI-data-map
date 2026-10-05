/*
 * menu.test.js - menu grounding: validMenu returns only catalogue actions,
 * off-menu entries are masked/excluded, entryForArgmax maps the winning
 * index back to the right menu entry (including masked positions).
 *
 * Run: node menu.test.js   (from tests/tokenizer-executor/)
 */
"use strict";

global.self = global; /* BEFORE requiring UMD modules */

var assert = require("assert");
var path = require("path");
function mod(name) {
  return require(path.join(__dirname, "..", "..", "web", "executor", "js", name));
}

var ST = mod("s1tokenize.js"); global.S1Tokenize = ST;
var U = mod("s1util.js"); global.S1Util = U;
var M = mod("menu.js"); global.S1Menu = M;
var A = mod("apply.js"); global.S1Apply = A;

var passed = 0, failed = 0;
function check(cond, msg) {
  passed++;
  try {
    assert.ok(cond, msg);
  } catch (e) {
    failed++;
    console.error("FAIL:", msg, "-", e.message);
  }
}

function names(menu) {
  return menu.map(function (e) { return e.action_name; });
}

/* Stub executor state for M.validMenu (reads _items, _itemIndex,
   _flagOpen(), _undoable()). */
function stubEx(itemIntent, itemIndex, flagOpen, undoable) {
  return {
    _items: [{ intent: itemIntent, params: { node_id: "n1" } }],
    _itemIndex: itemIndex,
    _flagOpen: function () { return flagOpen; },
    _undoable: function () { return undoable; }
  };
}

/* ---- sortMenu ordering ---- */
var unsorted = [
  { action_name: "skip_recipe_item", params: {} },
  { action_name: "abort_session", params: {} },
  { action_name: "add_node", params: { node_id: "n1" } },
  { action_name: "flag_for_review", params: {} }
];
var sorted = M.sortMenu(unsorted);
check(JSON.stringify(names(sorted)) === JSON.stringify(
  ["abort_session", "add_node", "flag_for_review", "skip_recipe_item"]),
  "sortMenu orders action_name ascending");
check(sorted.length === 4, "sortMenu keeps all entries");

/* tie-break by params_digest when action names are equal */
var tied = [
  { action_name: "connect", params: { a: "n9", b: "n2", cat: "payment" } },
  { action_name: "connect", params: { a: "n1", b: "n2", cat: "contact" } }
];
var tiedSorted = M.sortMenu(tied);
var d0 = U.digest8(tiedSorted[0].params), d1 = U.digest8(tiedSorted[1].params);
check(d0 <= d1, "sortMenu tie-breaks equal names by params_digest ascending");

/* ---- validMenu: normal state ---- */
var menu = M.validMenu(stubEx("add_node", 0, false, false));
check(menu.length === 4, "validMenu has 4 entries (intent, skip, flag, abort)");
check(names(menu).indexOf("add_node") !== -1, "menu carries the item intent");
check(names(menu).indexOf("skip_recipe_item") !== -1, "menu carries skip");
check(names(menu).indexOf("flag_for_review") !== -1, "menu always carries flag");
check(names(menu).indexOf("abort_session") !== -1, "menu always carries abort");
check(menu.length <= 5, "menu never exceeds 5 entries");
menu.forEach(function (e) {
  check(U.ACTIONS.indexOf(e.action_name) !== -1,
    "menu entry '" + e.action_name + "' is a catalogue action");
});
var skipEntry = menu.filter(function (e) {
  return e.action_name === "skip_recipe_item";
})[0];
check(skipEntry.params.item_index === 0, "skip entry targets the current item");
var intentEntry = menu.filter(function (e) {
  return e.action_name === "add_node";
})[0];
check(intentEntry.params.node_id === "n1",
  "intent entry carries a copy of the item params");

/* ---- validMenu: undoable state adds undo_last ---- */
var menuUndo = M.validMenu(stubEx("add_node", 0, false, true));
check(names(menuUndo).indexOf("undo_last") !== -1,
  "undo_last appears when history is undoable");
check(menuUndo.length === 5, "full menu is 5 entries");

/* ---- validMenu: flag open masks item actions ---- */
var menuFlag = M.validMenu(stubEx("add_node", 0, true, false));
check(JSON.stringify(names(menuFlag)) ===
  JSON.stringify(["abort_session", "flag_for_review"]),
  "open flag masks item intent and skip; only recovery actions remain");
menuFlag.forEach(function (e) {
  check(U.ACTIONS.indexOf(e.action_name) !== -1,
    "flag-state menu entry '" + e.action_name + "' is a catalogue action");
});

/* ---- validMenu: recipe complete ---- */
var menuDone = M.validMenu(stubEx("add_node", 1, false, false));
check(names(menuDone).indexOf("add_node") === -1,
  "completed recipe drops the item intent");
check(names(menuDone).indexOf("skip_recipe_item") === -1,
  "completed recipe drops skip_recipe_item");

/* ---- menuTokenFields: contract 5 shape ---- */
var fields = M.menuTokenFields(menu, "skeleton");
check(fields.length === menu.length, "one field object per menu entry");
fields.forEach(function (f, i) {
  var keys = Object.keys(f).sort();
  check(JSON.stringify(keys) === JSON.stringify(["action_name", "params_digest"]),
    "menu field " + i + " carries ONLY action_name + params_digest");
  check(f.action_name === menu[i].action_name,
    "menu field " + i + " names the right action");
  check(f.params_digest === U.digest8(menu[i].params),
    "menu field " + i + " digest matches digest8(params)");
});

/* ---- entryForArgmax: index mapping with masked positions ---- */
var menu4 = [
  { action_name: "a" }, { action_name: "b" },
  { action_name: "c" }, { action_name: "d" }
];
/* sequence length 10; menu tokens at positions 4,5,7 (rest masked off) */
function isMenuPos(positions) {
  return function (i) { return positions.indexOf(i) !== -1; };
}
var at457 = isMenuPos([4, 5, 7]);
check(M.entryForArgmax(menu4, 4, at457).menuIndex === 0, "argmax 4 -> menu 0");
check(M.entryForArgmax(menu4, 5, at457).menuIndex === 1, "argmax 5 -> menu 1");
check(M.entryForArgmax(menu4, 7, at457).menuIndex === 2, "argmax 7 -> menu 2");
check(M.entryForArgmax(menu4, 7, at457).entry.action_name === "c",
  "argmax 7 returns the third menu entry");
/* argmax landing on a masked (non-menu) position counts only earlier menu
   positions: position 6 sees menu tokens 4 and 5 -> index 1 */
check(M.entryForArgmax(menu4, 6, at457).menuIndex === 1,
  "masked argmax 6 maps via earlier menu positions to menu 1");
check(M.entryForArgmax(menu4, 9, at457).menuIndex === 2,
  "masked argmax 9 maps to the last menu entry");
var threw = null;
try {
  M.entryForArgmax(menu4, 0, isMenuPos([]));
} catch (e) { threw = e; }
check(threw !== null && /menu index -1/.test(threw.message),
  "argmax with no menu position before it throws");
threw = null;
try {
  M.entryForArgmax(menu4, 9, isMenuPos([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
} catch (e) { threw = e; }
check(threw !== null && /menu index 9 of 4/.test(threw.message),
  "argmax past the menu length throws");

/* ---- end-to-end grounding through the real Executor ---- */
function recipe(items) {
  return { recipe_id: "menu-test", schema_version: "1.0.0", items: items };
}
var ex = new A.Executor(recipe([
  { intent: "add_node", params: { node_id: "n1", type: "system", x: 100, y: 100, label: "CRM" } }
]));
var realMenu = ex.validMenu();
realMenu.forEach(function (e) {
  check(U.ACTIONS.indexOf(e.action_name) !== -1,
    "Executor.validMenu entry '" + e.action_name + "' is grounded in the catalogue");
});
var offMenu = null;
try {
  ex.apply("export", { format: "xls" });
} catch (e) { offMenu = e; }
check(offMenu !== null && /not in the valid-action menu/.test(offMenu.message),
  "apply rejects an off-menu action even with valid params");
var unknown = null;
try {
  ex.apply("frobnicate", {});
} catch (e) { unknown = e; }
check(unknown !== null && /not in the valid-action menu/.test(unknown.message),
  "apply rejects an unknown action name at the menu gate");

/* simulated model loop: scores with -inf off-menu, argmax over menu only */
ex.apply("add_node", { node_id: "n1", type: "system", x: 100, y: 100, label: "CRM" });
var m2 = ex.validMenu();
var T2 = 12, menuStart = 8; /* menu tokens at positions 8..8+m2.length-1 */
var mask = [];
for (var i = 0; i < T2; i++) {
  mask.push(i >= menuStart && i < menuStart + m2.length);
}
var scores = [];
for (var s = 0; s < T2; s++) {
  scores.push(mask[s] ? (s === menuStart + 1 ? 9.5 : 1.0 - s * 0.01) : -Infinity);
}
var best = -1, bestScore = -Infinity;
for (var q = 0; q < T2; q++) {
  if (mask[q] && scores[q] > bestScore) { bestScore = scores[q]; best = q; }
}
var mapped = M.entryForArgmax(m2, best, function (i) { return mask[i]; });
check(mapped.menuIndex === 1, "masked argmax resolves to menu index 1");
check(mapped.entry.action_name === m2[1].action_name,
  "masked argmax resolves to the right menu entry");

if (failed > 0) {
  console.error("FAILED: " + failed + " of " + passed);
  process.exitCode = 1;
} else {
  console.log("PASS " + passed);
}
