/*
 * apply.test.js - Executor logic: idempotency keys, tombstones, monotonic
 * seq, done marking, abort sealing, the 32-slot actions window, and the
 * out-of-band review-loop extensions.
 *
 * Run: node apply.test.js   (from tests/tokenizer-executor/)
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
function throwsRe(fn, re, msg) {
  var err = null;
  try { fn(); } catch (e) { err = e; }
  check(err !== null && re.test(err.message), msg +
    (err ? "" : " (nothing thrown)") +
    (err && !re.test(err.message) ? " (got: " + err.message + ")" : ""));
}

function recipe(id, items) {
  return { recipe_id: id, schema_version: "1.0.0", items: items };
}
function nodeParams(id, label) {
  return { node_id: id, type: "system", x: 100, y: 100, label: label || ("L-" + id) };
}
function fullRecipe() {
  return recipe("full-run", [
    { intent: "add_node", params: nodeParams("n1", "CRM") },
    { intent: "add_collection_point", params: { node_id: "n2", x: 200, y: 120, label: "Web form" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "set_field", params: { node_id: "n1", field: "label", value: "CRM v2" } },
    { intent: "set_retention",
      params: { node_id: "n1", record_type: "invoices", verify_only: true, as_of: "2020-01-15" } },
    { intent: "confirm_node", params: { node_id: "n1", note: "looks right" } },
    { intent: "run_check", params: { checks: ["label_coverage"] } },
    { intent: "export", params: { format: "xls" } }
  ]);
}

/* ---- module surface ---- */
check(A.SNAPSHOT_VERSION === "1.0.0", "SNAPSHOT_VERSION exported");
check(A.EXECUTOR_VERSION === "1.0.0", "EXECUTOR_VERSION exported");

/* ---- constructor validation ---- */
throwsRe(function () { new A.Executor({}); }, /recipe_id/,
  "rejects a missing recipe_id");
throwsRe(function () {
  new A.Executor(recipe("bad id!", [{ intent: "export", params: { format: "xls" } }]));
}, /recipe_id/, "rejects a recipe_id with illegal characters");
throwsRe(function () {
  new A.Executor({ recipe_id: "r", schema_version: "2.0.0", items: [{ intent: "export", params: {} }] });
}, /schema_version/, "rejects an unsupported schema_version");
throwsRe(function () {
  new A.Executor(recipe("r", []));
}, /non-empty array/, "rejects empty items");
throwsRe(function () {
  new A.Executor(recipe("r", [{ intent: "frobnicate", params: {} }]));
}, /unknown intent/, "rejects an unknown intent");
throwsRe(function () {
  new A.Executor(recipe("r", [{ intent: "export", params: "xls" }]));
}, /params must be an object/, "rejects non-object params");
throwsRe(function () {
  new A.Executor(recipe("r", [{ intent: "export", params: { blob: "x".repeat(5000) } }]));
}, /4096-byte limit/, "rejects params over the 4096-byte limit");

/* ---- happy-path full run ---- */
var ex = new A.Executor(fullRecipe());
var items = fullRecipe().items;
var hashes = [];
for (var i = 0; i < items.length; i++) {
  var r = ex.apply(items[i].intent, JSON.parse(JSON.stringify(items[i].params)));
  check(r.action_record.action_id === items[i].intent + ":" + i,
    "step " + i + " action_id is " + items[i].intent + ":" + i);
  check(/^[0-9a-f]{64}$/.test(r.action_record.state_hash),
    "step " + i + " state_hash is 64 hex chars");
  check(ex._done[i] === true, "item " + i + " marked done exactly once");
  hashes.push(r.action_record.state_hash);
}
check(ex._nodes.n1.label === "CRM v2", "set_field updated the label");
check(ex._nodes.n2.type === "collection", "collection point has the right type");
check(ex._edges.length === 1 && ex._edges[0].cat === "contact",
  "connect added the edge");
check(ex._annotations.some(function (a) { return a.kind === "retention"; }),
  "set_retention recorded a retention annotation");
check(ex._annotations.some(function (a) { return a.kind === "confirmation"; }),
  "confirm_node recorded a confirmation");
check(ex.resultFor("run_check", 6).report.label_coverage.pass === true,
  "run_check report recorded and passing");
check(ex.resultFor("export", 7).downloaded === "data-map-inventory.xls",
  "export recorded its download result");
check(ex._itemIndex === 8, "item index advanced past all 8 items");
check(new Set(hashes.slice(0, 6)).size === 6,
  "each mutating step changes the state hash");
check(hashes[6] === hashes[5], "run_check is non-mutating: hash unchanged");
check(hashes[7] === hashes[5], "export is non-mutating: hash unchanged");
check(ex.resultFor("add_node", 99) === null, "resultFor returns null when unapplied");

/* snapshot shape */
var snap = ex.snapshot();
["snapshot_version", "recipe_id", "item_index", "canvas", "annotations",
 "applied_keys", "actions", "dropped_prefix", "terminated", "abort_reason"
].forEach(function (k) {
  check(Object.prototype.hasOwnProperty.call(snap, k), "snapshot has key " + k);
});
check(snap.dropped_prefix.count === 0, "no dropped actions in a short run");

/* stateHash determinism */
var exB = new A.Executor(fullRecipe());
var itemsB = fullRecipe().items;
for (var j = 0; j < itemsB.length; j++) {
  exB.apply(itemsB[j].intent, JSON.parse(JSON.stringify(itemsB[j].params)));
}
check(ex.stateHash() === exB.stateHash(),
  "identical op sequences give identical state hashes");

/* ---- idempotency keys: same action+key twice yields one effect ---- */
var exI = new A.Executor(recipe("idem", [
  { intent: "add_node", params: nodeParams("n1", "CRM") }
]));
exI.apply("add_node", nodeParams("n1", "CRM"));
var flagP = { reason: "double-check this", item_index: 0 };
var f1 = exI.apply("flag_for_review", flagP);
var histBefore = exI._history.length;
var seqBefore = exI._seq;
var f2 = exI.apply("flag_for_review", JSON.parse(JSON.stringify(flagP)));
check(exI._annotations.filter(function (a) {
  return a.kind === "review_flag";
}).length === 1, "re-applied flag adds no second annotation");
check(exI._history.length === histBefore, "re-apply adds no history entry");
check(exI._seq === seqBefore, "re-apply does not bump the guide seq");
check(JSON.stringify(f1.action_record) === JSON.stringify(f2.action_record),
  "re-apply returns the recorded action_record");

/* ---- tombstones: undone actions cannot be replayed ---- */
var exT = new A.Executor(recipe("tomb", [
  { intent: "add_node", params: nodeParams("n1", "CRM") }
]));
exT.apply("add_node", nodeParams("n1", "CRM")); /* item 0 -> 1 */
exT.apply("flag_for_review", { reason: "r", item_index: 0 }); /* index stays 1 */
exT.apply("undo_last"); /* undoes the flag, tombstones key("flag_for_review", 1) */
check(exT._annotations.filter(function (a) {
  return a.kind === "review_flag";
}).length === 0, "undo cleared the flag annotation");
throwsRe(function () {
  exT.apply("flag_for_review", { reason: "stale replay", item_index: 0 });
}, /replay rejected/,
  "replaying a tombstoned key is rejected");
check(exT._annotations.filter(function (a) {
  return a.kind === "review_flag";
}).length === 0, "rejected replay resurrects nothing");
check(exT._tombstones[exT._key("flag_for_review", 1)] === true,
  "tombstone recorded for the undone key");
/* undo is itself idempotent: a second undo_last at the same item index
   hits the idempotency map and changes nothing. */
var hlen = exT._history.length;
exT.apply("undo_last");
check(exT._history.length === hlen,
  "second undo_last at the same key is a recorded no-op");
check(!!exT._nodes.n1, "n1 untouched by the no-op undo");

/* removed nodes stay removed across re-applies */
var exR = new A.Executor(recipe("tomb2", [
  { intent: "add_node", params: nodeParams("n1", "CRM") },
  { intent: "add_node", params: nodeParams("n2", "Site") }
]));
exR.apply("add_node", nodeParams("n1", "CRM"));
exR.apply("add_node", nodeParams("n2", "Site"));
var hashBeforeUndo = exR.stateHash();
exR.apply("undo_last"); /* removes n2, tombstones key("add_node", 1) */
check(!exR._nodes.n2, "removed node stays removed after undo");
check(!!exR._nodes.n1, "earlier node survives the undo");
check(exR.stateHash() !== hashBeforeUndo, "state hash reflects the removal");
check(exR._tombstones[exR._key("add_node", 1)] === true,
  "tombstone recorded for the removed node's key");

/* ---- monotonic seq: undo never moves the guide seq backward ---- */
var exS = new A.Executor(recipe("seq", [
  { intent: "add_node", params: nodeParams("n1", "A") },
  { intent: "add_node", params: nodeParams("n2", "B") },
  { intent: "add_node", params: nodeParams("n3", "C") }
]));
exS.apply("add_node", nodeParams("n1", "A"));
exS.apply("add_node", nodeParams("n2", "B"));
check(exS._seq === 2, "seq is 2 after two adds");
exS.apply("undo_last"); /* removes n2 */
check(exS._seq === 2, "seq does not decrement on undo");
check(!exS._nodes.n2, "n2 removed by undo");
/* If seq had gone backward, "n3" would be rejected as out of sequence. */
exS.apply("add_node", nodeParams("n3", "C"));
check(exS._seq === 3, "seq advanced to 3");
check(!!exS._nodes.n1 && !!exS._nodes.n3 && !exS._nodes.n2,
  "canvas holds n1 and n3, never resurrected n2");

/* ---- skip marks done and skipped ---- */
var exK = new A.Executor(recipe("skip", [
  { intent: "add_node", params: nodeParams("n1", "A") },
  { intent: "add_node", params: nodeParams("n1", "B") }
]));
exK.apply("skip_recipe_item", { item_index: 0, reason: "not needed" });
check(exK._done[0] === true && exK._skipped[0] === true,
  "skipped item marked done and skipped");
check(exK._itemIndex === 1, "skip advances past the item");
/* skipped item 0 never created a node, so the guide seq is still 0 and the next node id is still n1. */
exK.apply("add_node", nodeParams("n1", "B"));
check(exK._done[1] === true && exK._skipped[1] !== true,
  "executed item marked done but not skipped");

/* ---- abort seals the session ---- */
var exA = new A.Executor(recipe("abort", [
  { intent: "add_node", params: nodeParams("n1", "A") }
]));
exA.apply("abort_session", { reason: "stop now" });
check(exA._terminated === true && exA._abortReason === "stop now",
  "abort terminates with the reason");
throwsRe(function () { exA.apply("add_node", nodeParams("n1", "A")); },
  /terminated/, "no action applies after termination");
/* With empty history undo_last is not even in the menu, so the menu gate
   rejects before _doUndo runs; the _doUndo empty-history error is
   unreachable via apply() (defense in depth). */
throwsRe(function () {
  new A.Executor(recipe("u", [{ intent: "add_node", params: nodeParams("n1") }]))
    .apply("undo_last");
}, /not in the valid-action menu/, "undo with empty history is rejected at the menu gate");

/* ---- 32-slot actions window with prefix hash chain ---- */
var manyItems = [];
for (var m = 1; m <= 40; m++) {
  manyItems.push({ intent: "add_node", params: nodeParams("n" + m, "N" + m) });
}
var exW = new A.Executor(recipe("window", manyItems));
for (var w = 0; w < 40; w++) {
  exW.apply("add_node", nodeParams("n" + (w + 1), "N" + (w + 1)));
}
check(exW._actions.length === 32, "window keeps the last 32 action records");
check(exW._droppedCount === 8, "8 records dropped past the window");
check(exW._actions[0].action_id === "add_node:8",
  "oldest kept record is the 9th action");
check(/^[0-9a-f]{64}$/.test(exW._prefixHash), "prefix hash is 64 hex chars");
check(exW.snapshot().dropped_prefix.count === 8,
  "snapshot reports the dropped prefix count");

/* ---- out-of-band review-loop extensions ---- */
var exO = new A.Executor(recipe("oob", [
  { intent: "add_node", params: nodeParams("n1", "CRM") },
  { intent: "add_node", params: nodeParams("n2", "Site") }
]));
exO.apply("add_node", nodeParams("n1", "CRM"));
exO.apply("add_node", nodeParams("n2", "Site"));
var conf = exO.recordConfirmationOutOfBand("n1", "human ok", 0);
check(conf.node_id === "n1" && conf.item_index === 0,
  "out-of-band confirmation recorded");
check(exO._annotations.some(function (a) {
  return a.kind === "confirmation" && a.node_id === "n1";
}), "confirmation annotation present");
throwsRe(function () { exO.recordConfirmationOutOfBand("n99", "x", 0); },
  /does not exist/, "confirmation on a missing node is rejected");
exO.apply("flag_for_review", { reason: "look", item_index: 0 });
var cleared = exO.clearFlagsOutOfBand();
check(cleared.cleared === 1, "out-of-band flag clear reports one flag");
check(!exO._flagOpen(), "no flag open after the clear");
var rel = exO.applyCorrection({ op: "relabel", node_id: "n1", label: "CRM 2" });
check(rel.before.label === "CRM" && rel.after.label === "CRM 2",
  "relabel correction reports before/after");
check(exO._nodes.n1.label === "CRM 2", "relabel applied");
var ret = exO.applyCorrection({ op: "retype", node_id: "n1", type: "thirdparty" });
check(ret.before.type === "system" && ret.after.type === "thirdparty",
  "retype correction reports before/after");
var mov = exO.applyCorrection({ op: "move", node_id: "n1", x: 300, y: 200 });
check(mov.after.x === 300 && mov.after.y === 200, "move correction applied");
var rec = exO.applyCorrection({ op: "reconnect", a: "n1", b: "n2", cat: "payment" });
check(rec.after.cat === "payment" && exO._edges.length === 1,
  "reconnect correction added the edge");
var remE = exO.applyCorrection({ op: "remove_edge", a: "n1", b: "n2" });
check(remE.after === null && exO._edges.length === 0,
  "remove_edge correction removed the edge");
var vo = exO.applyCorrection({ op: "verify_only", node_id: "n1" });
check(vo.after.verify_only === true, "verify_only correction applied");
var remN = exO.applyCorrection({ op: "remove_node", node_id: "n2" });
check(remN.after === null && !exO._nodes.n2, "remove_node correction removed n2");
throwsRe(function () { exO.applyCorrection({ op: "nope", node_id: "n1" }); },
  /unknown correction op/, "unknown correction op is rejected");

if (failed > 0) {
  console.error("FAILED: " + failed + " of " + passed);
  process.exitCode = 1;
} else {
  console.log("PASS " + passed);
}
