/*
 * review-edit-ops.test.js - regression tests for the 2026-10-05 review
 * editing workspace: the new out-of-band correction ops (add_node,
 * add_edge, set_meta, remove_retention), meta carried through
 * deriveChecklist, the exporter Details sheet, and the FR template-name
 * composer (defect 3: no English in FR summaries).
 *
 * Run: node review-edit-ops.test.js   (from tests/tokenizer-executor/)
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
var R = mod("review.js"); global.S1Review = R;
var I = mod("i18n.js"); global.S1I18n = I;
var E = mod("exporter.js"); global.S1Exporter = E;

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

function freshEx() {
  return new A.Executor({
    recipe_id: "t-edit-01", schema_version: "1.0.0",
    items: [{ intent: "export", params: { format: "xls" } }]
  });
}

/* add_node: next-free id, canvas bounds, free spot, validation */
(function () {
  var ex = freshEx();
  ex._nodes = {
    n1: { type: "collection", x: 80, y: 80, label: "Web form" },
    n3: { type: "system", x: 235, y: 80, label: "CRM" }
  };
  var res = ex.applyCorrection({ op: "add_node", type: "thirdparty", label: "Stripe" });
  check(res.after.node_id === "n4", "add_node skips the id gap (n1,n3 -> n4)");
  var n = ex._nodes.n4;
  check(n && n.type === "thirdparty" && n.label === "Stripe", "add_node creates the node");
  check(n.x >= 40 && n.x <= 600 && n.y >= 40 && n.y <= 380, "add_node spot inside canvas bounds");
  check(Math.abs(n.x - 80) >= 70 || Math.abs(n.y - 80) >= 70, "add_node spot is free");
  throwsRe(function () { ex.applyCorrection({ op: "add_node", type: "bogus", label: "X" }); },
    /unknown node type/, "add_node rejects unknown type");
  throwsRe(function () { ex.applyCorrection({ op: "add_node", type: "system", label: "" }); },
    /1-200/, "add_node rejects empty label");
})();

/* add_edge: happy path + rejections */
(function () {
  var ex = freshEx();
  ex._nodes = {
    n1: { type: "collection", x: 80, y: 80, label: "A" },
    n2: { type: "system", x: 235, y: 80, label: "B" }
  };
  var res = ex.applyCorrection({ op: "add_edge", a: "n1", b: "n2", cat: "payment" });
  check(res.after.a === "n1" && res.after.cat === "payment", "add_edge adds the edge");
  throwsRe(function () { ex.applyCorrection({ op: "add_edge", a: "n1", b: "n2", cat: "contact" }); },
    /already connected/, "add_edge rejects duplicates");
  throwsRe(function () { ex.applyCorrection({ op: "add_edge", a: "n2", b: "n1", cat: "contact" }); },
    /already connected/, "add_edge rejects reverse duplicates");
  throwsRe(function () { ex.applyCorrection({ op: "add_edge", a: "n1", b: "n1", cat: "contact" }); },
    /self-loops/, "add_edge rejects self-loops");
  throwsRe(function () { ex.applyCorrection({ op: "add_edge", a: "n1", b: "n9", cat: "contact" }); },
    /does not exist/, "add_edge rejects missing nodes");
  throwsRe(function () { ex.applyCorrection({ op: "add_edge", a: "n1", b: "n2", cat: "bogus" }); },
    /unknown edge category/, "add_edge rejects unknown categories");
})();

/* set_meta: whitelist, lengths, node/edge targets, empty deletes */
(function () {
  var ex = freshEx();
  ex._nodes = {
    n1: { type: "collection", x: 80, y: 80, label: "A" },
    n2: { type: "system", x: 235, y: 80, label: "B" }
  };
  ex._edges = [{ a: "n1", b: "n2", cat: "contact" }];
  var res = ex.applyCorrection({ op: "set_meta", node_id: "n2", meta: { holds: "invoices", region: "Quebec" } });
  check(ex._nodes.n2.meta.holds === "invoices", "set_meta merges node meta");
  check(res.before && Object.keys(res.before).length === 0, "set_meta before is the prior meta");
  ex.applyCorrection({ op: "set_meta", node_id: "n2", meta: { region: "" } });
  check(!("region" in ex._nodes.n2.meta) && ex._nodes.n2.meta.holds === "invoices",
    "set_meta empty string deletes the key");
  ex.applyCorrection({ op: "set_meta", a: "n1", b: "n2", meta: { why: "billing" } });
  check(ex._edges[0].meta.why === "billing", "set_meta merges edge meta");
  throwsRe(function () { ex.applyCorrection({ op: "set_meta", node_id: "n2", meta: { evil: "x" } }); },
    /unknown meta field/, "set_meta rejects non-whitelisted fields");
  throwsRe(function () { ex.applyCorrection({ op: "set_meta", node_id: "n2", meta: { notes: new Array(502).join("x") } }); },
    /at most 500/, "set_meta enforces max lengths");
  throwsRe(function () { ex.applyCorrection({ op: "set_meta", node_id: "n9", meta: { notes: "x" } }); },
    /does not exist/, "set_meta rejects missing nodes");
})();

/* remove_retention */
(function () {
  var ex = freshEx();
  ex._nodes = { n1: { type: "system", x: 80, y: 80, label: "A" } };
  ex._annotations = [{ kind: "retention", node_id: "n1",
    payload: { record_type: "r", verify_only: true, as_of: "2026-01-01" } }];
  var res = ex.applyCorrection({ op: "remove_retention", node_id: "n1" });
  check(ex._annotations.length === 0, "remove_retention drops the annotation");
  check(res.before && res.before.verify_only === true, "remove_retention before carries the payload");
  throwsRe(function () { ex.applyCorrection({ op: "remove_retention", node_id: "n1" }); },
    /no retention note/, "remove_retention rejects a second removal");
})();

/* deriveChecklist carries meta; remove_node drops it */
(function () {
  var ex = freshEx();
  ex._nodes = {
    n1: { type: "system", x: 80, y: 80, label: "A", meta: { holds: "invoices" } },
    n2: { type: "collection", x: 200, y: 80, label: "B" }
  };
  ex._edges = [{ a: "n2", b: "n1", cat: "contact", meta: { why: "signup" } }];
  var rows = R.deriveChecklist(ex);
  var node = rows.filter(function (r) { return r.kind === "node" && r.node_id === "n1"; })[0];
  var edge = rows.filter(function (r) { return r.kind === "edge"; })[0];
  check(node && node.detail.meta.holds === "invoices", "checklist carries node meta");
  check(edge && edge.detail.meta.why === "signup", "checklist carries edge meta");
  ex.applyCorrection({ op: "remove_node", node_id: "n1" });
  check(!ex._nodes.n1 && ex._edges.length === 0, "remove_node drops the node, its meta, and its edges");
})();

/* exporter: Details sheet + metaText */
(function () {
  check(E.metaText({ holds: "invoices", region: "Quebec" }, "en") === "Holds: invoices; Region: Quebec",
    "metaText EN");
  check(E.metaText({ holds: "factures" }, "fr") === "Contient: factures", "metaText FR");
  check(E.metaText({}, "en") === "", "metaText empty meta");
  var checklist = [
    { ref: "node:n1", kind: "node", label: "CRM",
      detail: { type: "system", meta: { holds: "invoices", region: "Quebec" } }, status: "confirmed" },
    { ref: "edge:n2->n1", kind: "edge", label: "Form -> CRM",
      detail: { cat: "contact", meta: { why: "signup" } }, status: "unconfirmed" }
  ];
  var xml = E.buildDraftWorkbook(
    { nodes: { n1: { label: "CRM", type: "system" } }, edges: [] }, checklist, [], "en");
  check(xml.indexOf('ss:Name="Details"') !== -1, "Details sheet present (EN)");
  check(xml.indexOf("Holds: invoices; Region: Quebec") !== -1, "node details in the sheet");
  check(xml.indexOf("Why: signup") !== -1, "edge details in the sheet");
  check(xml.indexOf('ss:Name="Cover"') !== -1, "cover sheet kept");
  check(xml.indexOf('ss:Name="Review"') !== -1, "review sheet kept");
  check(xml.indexOf("DRAFT FOR REVIEW") !== -1, "DRAFT banner kept");
  var fr = E.buildDraftWorkbook({ nodes: {}, edges: [] }, checklist, [], "fr");
  check(fr.indexOf('ss:Name="Détails"') !== -1, "Details sheet localized (FR)");
})();

/* i18n.templateName: fully French summaries (defect 3) */
(function () {
  var fr = I.templateName({ size: "1-10", sector: "retail", region: "quebec", types: "contact-payment" }, "fr");
  check(fr === "1-10 employés, Commerce de détail, Québec seulement, Coordonnées et paiements",
    "FR summary composes from chip names, got " + JSON.stringify(fr));
  var EN_WORDS = /\b(steps?|retailer|payments?|contact|employees?)\b/i;
  check(!EN_WORDS.test(fr), "no English-only words in the FR summary");
  var fr2 = I.templateName({ size: "11-50", sector: "tech", region: "canada-us", types: "all" }, "fr");
  check(!EN_WORDS.test(fr2), "no English-only words in a second FR summary");
})();

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
