/*
 * executor.test.js - executor.js WITHOUT onnxruntime.
 *
 * Covered: serializeStep (frozen ordering, determinism, encodeStep
 * integration), Controller lifecycle (start/state/reset/setLang),
 * doneHeads completion predicates, the ort-free hooks (abort,
 * clearFlagAndContinue, recordConfirmation, applyCorrection), vendorUrl,
 * CANNED copy, and the pinned constants.
 *
 * Deliberately SKIPPED (need onnxruntime + the vendored model + fetch,
 * none of which exist in this environment):
 *  - ready(): loads the ort script, fetches vendor/model/model.onnx,
 *    verifies its SHA-256, and creates the InferenceSession.
 *  - Controller.stepOnce() / hooks.stepOnce() / hooks.runAll(): build ort
 *    tensors, run the session, argmax over menu scores, and apply.
 *  - doneHeads for run_check / export / undo_last: their predicates read
 *    Controller._runReports / _exportRecords / _steps, which only stepOnce
 *    populates.
 *
 * Run: node executor.test.js   (from tests/tokenizer-executor/)
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
var N = mod("narrate.js"); global.S1Narrate = N;
var X = mod("executor.js");

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

function recipe(id, items) {
  return { recipe_id: id, schema_version: "1.0.0", items: items };
}
function nodeParams(id, label) {
  return { node_id: id, type: "system", x: 100, y: 100, label: label || ("L-" + id) };
}

/* ---- pinned constants ---- */
check(X.hooks.ENCODING_VERSION === "1.0.0", "ENCODING_VERSION is 1.0.0");
check(/^[0-9a-f]{64}$/.test(X.hooks.MODEL_SHA256), "MODEL_SHA256 is 64 hex chars");
check(X.vendorUrl("vendor/model/model.onnx") === "vendor/model/model.onnx",
  "vendorUrl passes the path through with no document base");
check(X.CANNED.en.abort.length > 0 && X.CANNED.en.skip.length > 0 &&
  X.CANNED.en.flag.length > 0, "CANNED en has all three recovery lines");
check(X.CANNED.fr.abort === "Session arrêtée par l'utilisateur.",
  "CANNED fr abort wording");
check([X.CANNED.en.abort, X.CANNED.en.skip, X.CANNED.en.flag,
       X.CANNED.fr.abort, X.CANNED.fr.skip, X.CANNED.fr.flag
].every(function (s) { return s.indexOf("—") === -1; }),
  "CANNED copy has no em dashes");

/* ---- serializeStep: frozen ordering ---- */
var ex = new A.Executor(recipe("ser", [
  { intent: "add_node", params: nodeParams("n1", "CRM") },
  { intent: "add_collection_point",
    params: { node_id: "n2", x: 200, y: 120, label: "Web form" } },
  { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
  { intent: "set_retention",
    params: { node_id: "n1", record_type: "invoices", verify_only: true,
              as_of: "2020-01-15" } }
]));
var rp = recipe("ser", [
  { intent: "add_node", params: nodeParams("n1", "CRM") },
  { intent: "add_collection_point",
    params: { node_id: "n2", x: 200, y: 120, label: "Web form" } },
  { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
  { intent: "set_retention",
    params: { node_id: "n1", record_type: "invoices", verify_only: true,
              as_of: "2020-01-15" } }
]).items;
rp.forEach(function (item) {
  ex.apply(item.intent, JSON.parse(JSON.stringify(item.params)));
});
var ser = X.serializeStep(ex);
check(ser.ids[0] === ST.BOS, "first token is BOS");
check(ser.ids[ser.ids.length - 1] === ST.EOS, "last token is EOS");
var pSnap = ser.ids.indexOf(ST.SNAPSHOT_SEP);
var pAnnot = ser.ids.indexOf(ST.ANNOT_SEP);
var pMenu = ser.ids.indexOf(ST.MENU_SEP);
check(pSnap > 0 && pSnap < pAnnot && pAnnot < pMenu &&
  pMenu < ser.ids.length - 1, "separators in frozen order");
function inRange(ids, lo, hi, from, to, label) {
  for (var i = from; i < to; i++) {
    if (!(ids[i] >= lo && ids[i] < hi)) {
      check(false, label + ": token " + ids[i] + " at " + i + " out of range");
      return;
    }
  }
  check(true, label + ": all tokens in range");
}
inRange(ser.ids, ST.NODE_LO, ST.NODE_HI, 1, pSnap, "node section");
inRange(ser.ids, ST.EDGE_LO, ST.EDGE_HI, pSnap + 1, pAnnot, "edge section");
inRange(ser.ids, ST.ANNOT_LO, ST.ANNOT_HI, pAnnot + 1, pMenu, "annotation section");
var menuCount = ser.menu.length;
for (var mi = 0; mi < menuCount; mi++) {
  if (ser.ids[pMenu + 1 + mi] !== ST.MENU_LO + mi) {
    check(false, "menu token ids are MENU_LO+j in order");
    break;
  }
}
check(true, "menu token ids are MENU_LO+j in order");
check(ser.ids[pMenu + 1 + menuCount] === ST.EOS, "EOS follows the menu tokens");
check(ser.fields.length === ser.ids.length, "one field object per token");
ser.fields.slice(pMenu + 1, pMenu + 1 + menuCount).forEach(function (f, i) {
  var keys = Object.keys(f).sort();
  check(JSON.stringify(keys) === JSON.stringify(["action_name", "params_digest"]),
    "menu field " + i + " carries only action_name + params_digest");
  check(f.action_name === ser.menu[i].action_name,
    "menu field " + i + " matches menu order");
});
var nodeField = ser.fields[1];
check(nodeField.node_id === "n1" && nodeField.label === "CRM" &&
  nodeField.x === 100 && nodeField.y === 100,
  "node field carries node_id/label/x/y");
check(typeof nodeField.type === "number", "node field type is the enum value");

/* determinism */
var ser2 = X.serializeStep(ex);
check(JSON.stringify(ser.ids) === JSON.stringify(ser2.ids),
  "serializeStep token ids are deterministic");
check(JSON.stringify(ser.fields) === JSON.stringify(ser2.fields),
  "serializeStep fields are deterministic");
check(JSON.stringify(ser.menu.map(function (e) { return e.action_name; })) ===
  JSON.stringify(ex.validMenu().map(function (e) { return e.action_name; })),
  "serialized menu matches validMenu");

/* encodeStep integration: the serialized step must encode cleanly */
var enc = ST.encodeStep(ser.ids,
  ser.fields.map(function (f) { return JSON.stringify(f); }));
var masked = enc.menu_mask.filter(function (m) { return m; }).length;
check(masked === menuCount, "menu_mask marks exactly the menu tokens");
check(enc.menu_mask.slice(pMenu + 1, pMenu + 1 + menuCount)
  .every(function (m) { return m; }), "menu_mask is contiguous over the menu");

/* empty canvas still serializes (menu keeps the step non-empty) */
var exEmpty = new A.Executor(recipe("empty", [
  { intent: "export", params: { format: "xls" } }
]));
var serE = X.serializeStep(exEmpty);
check(serE.ids[0] === ST.BOS && serE.ids[1] === ST.SNAPSHOT_SEP,
  "empty canvas: snapshot separator follows BOS");
ST.encodeStep(serE.ids, serE.fields.map(function (f) { return JSON.stringify(f); }));
check(true, "empty-canvas step encodes without error");

/* ---- Controller lifecycle ---- */
var C = new X.Controller();
check(JSON.stringify(C.doneHeads()) === "{}", "doneHeads is {} before start");
var started = C.start(recipe("ctl", [
  { intent: "add_node", params: nodeParams("n1", "CRM") }
]));
check(started.recipe_id === "ctl" && started.items === 1,
  "start returns recipe_id and item count");
check(/^s1-[0-9a-f]{12}$/.test(started.session_id),
  "start returns a session id");
check(C.lang() === "en", "default language is en");
C.setLang("fr");
check(C.lang() === "fr", "setLang(fr) sticks");
C.setLang("xx");
check(C.lang() === "en", "unknown language falls back to en");
var st0 = C.state();
check(st0.item_index === 0 && st0.terminated === false && st0.steps === 0,
  "fresh state is at item 0, unterminated");
check(JSON.stringify(st0.nodes) === "{}", "fresh state has no nodes");
C.executor().apply("add_node", nodeParams("n1", "CRM"));
var st1 = C.state();
check(st1.nodes.n1.label === "CRM" && st1.item_index === 1,
  "state reflects applied actions");
check(/^[0-9a-f]{64}$/.test(st1.state_hash), "state carries a state hash");
var tr = C.trace();
check(tr.steps.length === 0 && tr.encoding_version === "1.0.0",
  "trace has no model steps without stepOnce");
check(JSON.stringify(C.doneHeads()) === JSON.stringify({ 0: true }),
  "doneHeads marks the applied add_node done");
C.reset();
check(C.state() === null && C.sessionId() === null,
  "reset clears the session");

/* ---- doneHeads across intents ---- */
var dhItems = [
  { intent: "add_node", params: nodeParams("n1", "CRM") },
  { intent: "add_collection_point",
    params: { node_id: "n2", x: 200, y: 120, label: "Web" } },
  { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
  { intent: "set_field",
    params: { node_id: "n1", field: "label", value: "CRM2" } },
  { intent: "set_retention",
    params: { node_id: "n1", record_type: "invoices", verify_only: true,
              as_of: "2020-01-15" } },
  { intent: "confirm_node", params: { node_id: "n1" } }
];
var CD = new X.Controller();
CD.start(recipe("dh", dhItems));
var before = CD.doneHeads();
check(Object.keys(before).every(function (k) { return before[k] === false; }),
  "all done-heads false before any action");
dhItems.forEach(function (item, i) {
  CD.executor().apply(item.intent, JSON.parse(JSON.stringify(item.params)));
  check(CD.doneHeads()[i] === true,
    "head " + i + " (" + item.intent + ") true right after its apply");
});
var after = CD.doneHeads();
check(after[1] === true && after[2] === true && after[3] === true &&
  after[4] === true && after[5] === true,
  "later heads stay true at the end");
check(after[0] === false,
  "add_node head is a live predicate: the later set_field changed n1 label");

/* set_retention with a cited range (non-verify branch) */
var CR = new X.Controller();
CR.start(recipe("dhr", [
  { intent: "add_node", params: nodeParams("n1", "CRM") },
  { intent: "set_retention",
    params: { node_id: "n1", record_type: "invoices", range_min_years: 2,
              range_max_years: 7, statute: "Tax Act s. 230(4)",
              as_of: "2020-01-15" } }
]));
CR.executor().apply("add_node", nodeParams("n1", "CRM"));
check(CR.doneHeads()[1] === false, "retention head false before apply");
CR.executor().apply("set_retention",
  { node_id: "n1", record_type: "invoices", range_min_years: 2,
    range_max_years: 7, statute: "Tax Act s. 230(4)", as_of: "2020-01-15" });
check(CR.doneHeads()[1] === true, "retention head true after cited apply");

/* skip / abort / flag heads */
var CK = new X.Controller();
CK.start(recipe("dhk", [{ intent: "skip_recipe_item", params: {} }]));
CK.executor().apply("skip_recipe_item", { item_index: 0, reason: "n/a" });
check(CK.doneHeads()[0] === true, "skip head true after skip");
var CA = new X.Controller();
CA.start(recipe("dha", [{ intent: "abort_session", params: {} }]));
CA.executor().apply("abort_session", { reason: "stop" });
check(CA.doneHeads()[0] === true, "abort head true after abort");
var CF = new X.Controller();
CF.start(recipe("dhf", [{ intent: "flag_for_review",
  params: { reason: "look", item_index: 0 } }]));
CF.executor().apply("flag_for_review", { reason: "look", item_index: 0 });
check(CF.doneHeads()[0] === true, "flag head true while the flag is open");

/* ---- ort-free hooks ---- */
X.hooks.reset();
X.hooks.start(recipe("hk", [{ intent: "add_node", params: nodeParams("n1") }]));
X.hooks.setLang("fr");
check(X.hooks.controller.lang() === "fr", "hooks.setLang reaches the controller");
var hs = X.hooks.state();
check(hs.recipe_id === "hk" && hs.items === 1, "hooks.state reflects start");
var aborted = X.hooks.abort("operator stop");
check(aborted.snapshot.terminated === true, "hooks.abort terminates");
check(X.hooks.state().terminated === true, "state shows terminated");
check(X.hooks.ENCODING_VERSION === "1.0.0", "hooks expose ENCODING_VERSION");
check(X.hooks.controller instanceof X.Controller, "hooks expose the Controller");
X.hooks.reset();
check(X.hooks.state() === null, "hooks.reset clears state");

X.hooks.start(recipe("hk2", [{ intent: "add_node", params: nodeParams("n1") }]));
X.hooks.controller.executor().apply("add_node", nodeParams("n1"));
X.hooks.controller.executor().apply("flag_for_review",
  { reason: "r", item_index: 0 });
check(X.hooks.clearFlagAndContinue().cleared === 1,
  "hooks.clearFlagAndContinue clears the flag");
var rc = X.hooks.recordConfirmation("n1", "human ok");
check(rc.node_id === "n1", "hooks.recordConfirmation records");
var corr = X.hooks.applyCorrection({ op: "relabel", node_id: "n1", label: "Z" });
check(corr.after.label === "Z" &&
  X.hooks.controller.executor()._nodes.n1.label === "Z",
  "hooks.applyCorrection applies the correction");
X.hooks.reset();

if (failed > 0) {
  console.error("FAILED: " + failed + " of " + passed);
  process.exitCode = 1;
} else {
  console.log("PASS " + passed);
}
