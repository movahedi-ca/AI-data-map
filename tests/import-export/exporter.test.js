/**
 * exporter.test.js - draft workbook exporter (Review + Confirmations sheets).
 *
 * Covers: SpreadsheetML structure and well-formedness, the required sheets
 * (inventory + Review + Confirmations), the frozen header contracts, review
 * checklist rows and confirmation records referencing the exported nodes,
 * draft-for-review labeling on every sheet, cell-value escaping, and the
 * re-import round trip through the Phase 1 importer ("4 systems placed,
 * 3 connections drawn").
 *
 * Run: node exporter.test.js   (from this directory)
 * No DOM, no network. DOM shim: global.self plus the S1Tokenize/S1Util chain.
 */
"use strict";

global.self = global;
global.S1Tokenize = require("../../web/executor/js/s1tokenize.js");
global.S1Util = require("../../web/executor/js/s1util.js");
const assert = require("assert");

const exporter = require("../../web/executor/js/exporter.js");
const { parseSpreadsheetML, findInventorySheets } =
  require("../../web/import/engine/spreadsheetml-parser.js");
const { mapColumns } = require("../../web/import/engine/column-mapper.js");
const { toCanonicalModel } = require("../../web/import/engine/canonical-model.js");
const { validate } = require("../../web/import/engine/validate.js");
const { buildState } = require("../../web/import/engine/state-builder.js");

/* ------------------------------------------------------------------ */
/* mini runner                                                         */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];
function t(name, fn) {
  try { fn(); }
  catch (e) { failures.push(name + ": " + (e && e.message)); }
}
function ok(v, msg) { passed++; assert.ok(v, msg); }
function eq(a, b, msg) { passed++; assert.strictEqual(a, b, msg); }
function deq(a, b, msg) { passed++; assert.deepStrictEqual(a, b, msg); }

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const STATE = {
  nodes: {
    n1: { type: "collection", x: 80, y: 80, label: "Checkout form" },
    n2: { type: "system", x: 310, y: 80, label: "Shopify" },
    n3: { type: "thirdparty", x: 545, y: 80, label: "Klaviyo" },
    n4: { type: "destruction", x: 310, y: 340, label: "Old backups" },
  },
  edges: [
    { a: "n1", b: "n2", cat: "payment" },
    { a: "n2", b: "n3", cat: "marketing" },
    { a: "n2", b: "n4", cat: "contact" },
  ],
  seq: 4,
};

const CHECKLIST = [
  { ref: "node:n1", kind: "node", label: "Checkout form", detail: { type: "collection", x: 80, y: 80 }, status: "confirmed" },
  { ref: "node:n2", kind: "node", label: "Shopify", detail: { type: "system", x: 310, y: 80 }, status: "unconfirmed" },
  { ref: "node:n3", kind: "node", label: "Klaviyo", detail: { type: "thirdparty", x: 545, y: 80 }, status: "unconfirmed" },
  { ref: "node:n4", kind: "node", label: "Old backups", detail: { type: "destruction", x: 310, y: 340 }, status: "unconfirmed" },
  { ref: "edge:n1->n2", kind: "edge", label: "Checkout form -> Shopify", detail: { cat: "payment" }, status: "unconfirmed" },
  { ref: "edge:n2->n3", kind: "edge", label: "Shopify -> Klaviyo", detail: { cat: "marketing" }, status: "unconfirmed" },
  { ref: "edge:n2->n4", kind: "edge", label: "Shopify -> Old backups", detail: { cat: "contact" }, status: "confirmed" },
  { ref: "retention:n2", kind: "retention", label: "Shopify", detail: { record_type: "orders", range: "7 to 7 years", statute: "tax law" }, status: "unconfirmed" },
  { ref: "node:n9", kind: "node", label: "Dropped draft", detail: {}, removed: true, status: "unconfirmed" },
];

const CONFIRMATIONS = [
  { session_id: "sess-1", recipe_id: "rec-7", item_index: 0, ref: "node:n1", label: "Checkout form", note: "verified with the walkthrough", by: "reviewer", at: "2026-10-05T04:00:00.000Z" },
  { session_id: "sess-1", recipe_id: "rec-7", item_index: 6, ref: "edge:n2->n4", label: "Shopify -> Old backups", note: "", by: "reviewer", at: "2026-10-05T04:01:00.000Z" },
];

function sheetNames(xml) {
  const out = [];
  const re = /<Worksheet ss:Name="([^"]+)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function sheetRows(xml, name) {
  const sheets = parseSpreadsheetML(xml);
  const s = sheets.find((x) => x.name === name);
  if (!s) throw new Error("sheet missing: " + name);
  return s.rows;
}

/* ------------------------------------------------------------------ */
/* structure: well-formed XML, required sheets                          */
/* ------------------------------------------------------------------ */

t("output is well-formed SpreadsheetML with the four required sheets", () => {
  const xml = exporter.buildDraftWorkbook(STATE, CHECKLIST, CONFIRMATIONS, "en");
  ok(xml.startsWith("\uFEFF"), "BOM first");
  ok(xml.includes('<?xml version="1.0" encoding="UTF-8"?>'), "XML declaration present");
  ok(xml.includes('xmlns="urn:schemas-microsoft-com:office:spreadsheet"'), "SpreadsheetML namespace present");
  deq(sheetNames(xml), ["Nodes", "Connections", "Review", "Confirmations"], "sheet order and names");
  const count = (tag) => (xml.match(new RegExp("<" + tag + "\\b", "g")) || []).length;
  const countClose = (tag) => (xml.match(new RegExp("</" + tag + ">", "g")) || []).length;
  eq(count("Worksheet"), countClose("Worksheet"), "worksheets balanced");
  eq(count("Table"), countClose("Table"), "tables balanced");
  eq(count("Row"), countClose("Row"), "rows balanced");
  eq(count("Cell"), countClose("Cell"), "cells balanced");
  eq(count("Data"), countClose("Data"), "data elements balanced");
  eq(count("Workbook"), 1, "one workbook open");
  eq(countClose("Workbook"), 1, "one workbook close");
  ok(!/\u2014/.test(xml), "no em dashes anywhere in the output");
});

t("FR output carries the FR sheet names", () => {
  const xml = exporter.buildDraftWorkbook(STATE, CHECKLIST, CONFIRMATIONS, "fr");
  deq(sheetNames(xml), ["Nœuds", "Liens", "Révision", "Confirmations"], "FR sheet names");
  ok(!/\u2014/.test(xml), "no em dashes in the FR output");
});

/* ------------------------------------------------------------------ */
/* frozen header contracts                                              */
/* ------------------------------------------------------------------ */

t("inventory sheets keep the Phase 1 header contract", () => {
  const xml = exporter.buildDraftWorkbook(STATE, CHECKLIST, CONFIRMATIONS, "en");
  deq(sheetRows(xml, "Nodes")[2], ["Label", "Type"], "Nodes header");
  deq(sheetRows(xml, "Connections")[0], ["From", "To", "Category"], "Connections header");
  const nodeRows = sheetRows(xml, "Nodes");
  eq(nodeRows.length, 7, "disclaimer + blank + header + 4 nodes");
  eq(nodeRows[0][0], exporter.draftBanner("en"), "Nodes disclaimer is the draft banner");
  deq(nodeRows[1], [""], "blank row after the disclaimer");
});

t("Review sheet header matches the contract", () => {
  const xml = exporter.buildDraftWorkbook(STATE, CHECKLIST, CONFIRMATIONS, "en");
  const rows = sheetRows(xml, "Review");
  deq(rows[2], ["Ref", "Artifact", "Detail", "Status"], "Review header");
  eq(rows[0][0], exporter.draftBanner("en"), "Review disclaimer is the draft banner");
  const fr = exporter.buildDraftWorkbook(STATE, CHECKLIST, CONFIRMATIONS, "fr");
  deq(sheetRows(fr, "Révision")[2], ["Réf", "Élément", "Détail", "Statut"], "FR Review header");
});

t("Confirmations sheet header matches the contract", () => {
  const xml = exporter.buildDraftWorkbook(STATE, CHECKLIST, CONFIRMATIONS, "en");
  const rows = sheetRows(xml, "Confirmations");
  deq(rows[2], ["Session", "Recipe", "Item", "Ref", "Artifact", "Note", "By", "At"], "Confirmations header");
  eq(rows[0][0], exporter.draftBanner("en"), "Confirmations disclaimer is the draft banner");
});

/* ------------------------------------------------------------------ */
/* Review sheet rows                                                    */
/* ------------------------------------------------------------------ */

t("Review rows reference the exported nodes and carry status", () => {
  const xml = exporter.buildDraftWorkbook(STATE, CHECKLIST, CONFIRMATIONS, "en");
  const rows = sheetRows(xml, "Review");
  eq(rows.length, 3 + CHECKLIST.length, "one row per checklist item");
  const byRef = {};
  for (const r of rows.slice(3)) byRef[r[0]] = r;
  deq(byRef["node:n1"], ["node:n1", "node: Checkout form", "Collection point (80, 80)", "confirmed"], "confirmed node row");
  deq(byRef["node:n2"], ["node:n2", "node: Shopify", "System (310, 80)", "unconfirmed"], "unconfirmed node row");
  deq(byRef["edge:n1->n2"], ["edge:n1->n2", "edge: Checkout form -> Shopify", "Payment", "unconfirmed"], "edge row with category display");
  deq(byRef["edge:n2->n4"][3], "confirmed", "confirmed edge status");
  deq(byRef["retention:n2"], ["retention:n2", "retention: Shopify", "orders: 7 to 7 years (tax law)", "unconfirmed"], "retention row detail");
  deq(byRef["node:n9"], ["node:n9", "node: Dropped draft", "removed during review", "unconfirmed"], "removed row labeled");
});

t("FR Review rows use the FR labels", () => {
  const xml = exporter.buildDraftWorkbook(STATE, CHECKLIST, CONFIRMATIONS, "fr");
  const rows = sheetRows(xml, "Révision");
  const byRef = {};
  for (const r of rows.slice(3)) byRef[r[0]] = r;
  deq(byRef["node:n1"][3], "confirmé", "FR confirmed status");
  deq(byRef["node:n2"][3], "non confirmé", "FR unconfirmed status");
  ok(byRef["node:n1"][1].startsWith("nœud:"), "FR node kind label");
  ok(byRef["edge:n1->n2"][1].startsWith("lien:"), "FR edge kind label");
  ok(byRef["retention:n2"][1].startsWith("conservation:"), "FR retention kind label");
  eq(byRef["node:n9"][2], "supprimé pendant la révision", "FR removed label");
});

/* ------------------------------------------------------------------ */
/* Confirmations sheet rows                                             */
/* ------------------------------------------------------------------ */

t("confirmation records land on the Confirmations sheet verbatim", () => {
  const xml = exporter.buildDraftWorkbook(STATE, CHECKLIST, CONFIRMATIONS, "en");
  const rows = sheetRows(xml, "Confirmations");
  eq(rows.length, 3 + CONFIRMATIONS.length, "one row per confirmation");
  deq(rows[3], ["sess-1", "rec-7", "0", "node:n1", "Checkout form", "verified with the walkthrough", "reviewer", "2026-10-05T04:00:00.000Z"], "first record exact");
  deq(rows[4], ["sess-1", "rec-7", "6", "edge:n2->n4", "Shopify -> Old backups", "", "reviewer", "2026-10-05T04:01:00.000Z"], "second record exact, empty note stays empty");
});

t("empty confirmations still emit the sheet with headers", () => {
  const xml = exporter.buildDraftWorkbook(STATE, CHECKLIST, [], "en");
  const rows = sheetRows(xml, "Confirmations");
  eq(rows.length, 3, "disclaimer + blank + header only");
});

/* ------------------------------------------------------------------ */
/* draft labeling on every sheet                                        */
/* ------------------------------------------------------------------ */

t("every sheet carries draft-for-review labeling (Connections keeps the frozen Phase 1 shape)", () => {
  const xml = exporter.buildDraftWorkbook(STATE, CHECKLIST, CONFIRMATIONS, "en");
  const banner = exporter.draftBanner("en");
  for (const name of ["Nodes", "Review", "Confirmations"]) {
    eq(sheetRows(xml, name)[0][0], banner, name + " carries the banner");
  }
  // The Connections sheet keeps the frozen Phase 1 row shape (header first)
  // so the column mapper still sees it with confidence 1.0.
  deq(sheetRows(xml, "Connections")[0], ["From", "To", "Category"], "Connections header is row 0");
  const occurrences = xml.split(banner).length - 1;
  eq(occurrences, 3, "banner appears once on Nodes, Review, and Confirmations");
  const fr = exporter.buildDraftWorkbook(STATE, CHECKLIST, CONFIRMATIONS, "fr");
  ok(fr.includes("BROUILLON À RÉVISER"), "FR banner text present");
  ok(!/DRAFT FOR REVIEW/.test(fr), "no EN banner leaks into the FR workbook");
});

t("draftBanner is exposed and correct in both languages", () => {
  eq(exporter.draftBanner("en"), "DRAFT FOR REVIEW. Verify every row before use. Not legal advice.", "EN banner");
  eq(exporter.draftBanner("fr"), "BROUILLON À RÉVISER. Vérifiez chaque ligne avant usage. Pas un avis juridique.", "FR banner");
  eq(exporter.draftBanner("de"), exporter.draftBanner("en"), "unknown language falls back to EN");
});

/* ------------------------------------------------------------------ */
/* cell escaping                                                        */
/* ------------------------------------------------------------------ */

t("cell values are XML-escaped and survive a re-parse", () => {
  const tricky = {
    nodes: {
      n1: { type: "system", x: 1, y: 1, label: "R&D <core> & \"quotes\"" },
      n2: { type: "system", x: 2, y: 2, label: "=1+1 stays text" },
    },
    edges: [],
    seq: 2,
  };
  const xml = exporter.buildDraftWorkbook(tricky, [], [], "en");
  ok(xml.includes("R&amp;D &lt;core&gt; &amp; &quot;quotes&quot;"), "entities escaped in the raw XML");
  ok(!/R&D <core>/.test(xml), "no raw angle brackets or bare ampersands");
  const rows = sheetRows(xml, "Nodes");
  eq(rows[3][0], "R&D <core> & \"quotes\"", "label restored exactly on re-parse");
  eq(rows[4][0], "=1+1 stays text", "formula-looking text stays text");
  ok(/ss:Type="String"/.test(xml), "cells are typed String");
});

/* ------------------------------------------------------------------ */
/* DMEngine path: the Phase 1 builder drives the inventory sheets        */
/* ------------------------------------------------------------------ */

t("with DMEngine present, inventory sheets come from the Phase 1 builder", () => {
  const { buildSpreadsheetML } = require("../../web/import/engine/spreadsheetml-parser.js");
  global.window = { DMEngine: { buildSpreadsheetML } };
  try {
    const xml = exporter.buildDraftWorkbook(STATE, CHECKLIST, CONFIRMATIONS, "en");
    deq(sheetNames(xml), ["Nodes", "Connections", "Review", "Confirmations"], "four sheets with DMEngine");
    const rows = sheetRows(xml, "Nodes");
    eq(rows[0][0], "Draft inventory for review. Not legal advice.", "Phase 1 disclaimer used");
    eq(rows.length, 7, "Phase 1 row layout: disclaimer + blank + header + 4 nodes");
    const reviewRows = sheetRows(xml, "Review");
    eq(reviewRows.length, 3 + CHECKLIST.length, "Review sheet still appended");
  } finally {
    delete global.window;
  }
});

/* ------------------------------------------------------------------ */
/* re-import round trip through the Phase 1 importer                    */
/* ------------------------------------------------------------------ */

t("re-import restores 4 systems placed and 3 connections drawn", () => {
  const xml = exporter.buildDraftWorkbook(STATE, CHECKLIST, CONFIRMATIONS, "en");
  const sheets = parseSpreadsheetML(xml);
  // Extra sheets are ignored by findInventorySheets; node/edge sheets keep
  // their Phase 1 shape.
  const inv = findInventorySheets(sheets);
  ok(inv.nodes && inv.connections, "inventory sheets found");
  ok(!findInventorySheets(sheets).nodes || inv.nodes.name === "Nodes", "Nodes sheet selected");
  const kinds = [inv.nodes, inv.connections].map((s) => mapColumns(s));
  deq(kinds.map((k) => k.kind), ["exporter-nodes", "exporter-connections"], "re-import kinds");
  ok(kinds.every((k) => k.confidence === 1.0), "re-import confidence 1.0");
  const ms = [inv.nodes, inv.connections].map((s, i) => toCanonicalModel(kinds[i], s.rows));
  const systems = ms[0].systems, flows = ms[1].flows;
  eq(systems.length, 4, "4 systems restored");
  eq(flows.length, 3, "3 flows restored");
  deq(ms[0].rejected, [], "no system rejections");
  deq(ms[1].rejected, [], "no flow rejections");
  const flags = validate({ systems, flows });
  deq(flags, [], "no validation flags");
  const rebuilt = buildState({ systems, flows }, { categories: {} });
  eq(Object.keys(rebuilt.nodes).length, 4, "4 systems placed");
  deq(Object.keys(rebuilt.nodes), ["n1", "n2", "n3", "n4"], "node ids ascend with no gaps");
  eq(rebuilt.edges.length, 3, "3 connections drawn");
  deq(rebuilt.rejected, [], "nothing rejected");
  const labelOf = (id) => rebuilt.nodes[id].label;
  const edgeTriples = rebuilt.edges.map((e) => [labelOf(e.a), labelOf(e.b), e.cat].join("|")).sort();
  deq(edgeTriples, [
    "Checkout form|Shopify|payment",
    "Shopify|Klaviyo|marketing",
    "Shopify|Old backups|contact",
  ], "the three connections are the original ones");
  const types = {};
  for (const n of Object.values(rebuilt.nodes)) types[n.label] = n.type;
  deq(types, {
    "Checkout form": "collection",
    "Shopify": "system",
    "Klaviyo": "thirdparty",
    "Old backups": "destruction",
  }, "types restored exactly");
});

t("re-import of the FR workbook restores the FR systems and connections", () => {
  const xml = exporter.buildDraftWorkbook(STATE, CHECKLIST, CONFIRMATIONS, "fr");
  const inv = findInventorySheets(parseSpreadsheetML(xml));
  ok(inv.nodes && inv.connections, "FR inventory sheets found");
  const kinds = [inv.nodes, inv.connections].map((s) => mapColumns(s));
  ok(kinds.every((k) => k.confidence === 1.0), "FR re-import confidence 1.0");
  const ms = [inv.nodes, inv.connections].map((s, i) => toCanonicalModel(kinds[i], s.rows));
  const rebuilt = buildState({ systems: ms[0].systems, flows: ms[1].flows }, { categories: {} });
  eq(Object.keys(rebuilt.nodes).length, 4, "FR 4 systems placed");
  eq(rebuilt.edges.length, 3, "FR 3 connections drawn");
  deq(validate({ systems: ms[0].systems, flows: ms[1].flows }), [], "FR re-import flag-free");
});

t("empty state exports and re-imports as an empty inventory", () => {
  const xml = exporter.buildDraftWorkbook({ nodes: {}, edges: [], seq: 0 }, [], [], "en");
  deq(sheetNames(xml), ["Nodes", "Connections", "Review", "Confirmations"], "sheets still present");
  const inv = findInventorySheets(parseSpreadsheetML(xml));
  const kinds = [inv.nodes, inv.connections].map((s) => mapColumns(s));
  const ms = [inv.nodes, inv.connections].map((s, i) => toCanonicalModel(kinds[i], s.rows));
  deq(ms[0].systems, [], "no systems");
  deq(ms[1].flows, [], "no flows");
});

/* ------------------------------------------------------------------ */

if (failures.length) {
  for (const f of failures) console.error("FAIL " + f);
  console.error("FAILED " + failures.length + " test(s), " + passed + " assertion(s) passed before failure");
  process.exitCode = 1;
} else {
  console.log("PASS " + passed);
}
