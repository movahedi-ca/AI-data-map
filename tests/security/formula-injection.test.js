"use strict";
/* formula-injection.test.js - hostile cell values must stay inert data.
 *
 * Run: node tests/security/formula-injection.test.js   (from the repo root)
 *
 * What the sources actually do (verified by reading them): neither
 * web/executor/js/exporter.js nor web/import/engine/spreadsheetml-parser.js
 * (and the engine-bundle.js copy of the same builder) prefix or quote
 * leading = + - @. The neutralization mechanism is structural instead:
 * every cell is emitted as <Data ss:Type="String">...</Data> and no
 * ss:Formula attribute is ever written, so spreadsheet apps treat the
 * content as a text literal, never as a formula. Cell text is XML-escaped.
 *
 * This test asserts that real safety property on generated XML for a
 * crafted fixture, through BOTH builders (the executor's draft-workbook
 * builder and the engine's buildSpreadsheetML, which the exporter uses
 * when window.DMEngine is present):
 *  1. every <Cell> in the output carries ss:Type="String";
 *  2. the substring ss:Formula never appears;
 *  3. XML metacharacters are escaped;
 *  4. an export -> parse -> state round trip through the REAL
 *     SpreadsheetML parser returns each hostile value verbatim,
 *     proving it was stored as inert text.
 *
 * Vectors: = + - @ prefixes, tab/CR prefixes, pipe, DDE-style
 * =cmd|..., =HYPERLINK(...), unicode text with a formula prefix.
 *
 * No em dashes.
 */
global.self = global;

const assert = require("assert");
const path = require("path");

const WEB = path.resolve(__dirname, "..", "..", "web");

let n = 0;
function ok(cond, msg) { n++; assert.ok(cond, msg); }
function eq(a, b, msg) { n++; assert.strictEqual(a, b, msg); }

const VECTORS = [
  "=1+1",
  "=cmd|'/c calc'!A0",
  "+1+1",
  "-2+3",
  "@SUM(1+1)",
  "\t=1+1",
  "|1+1",
  "=HYPERLINK(\"http://evil.example\",\"click me\")",
  "@malicious.macro()",
  "O'Brien=1+1",
  "=2+2; cmd|'/c calc'!A0",
];

function fixture() {
  const nodes = {};
  VECTORS.forEach((v, i) => {
    nodes["n" + (i + 1)] = { type: "system", x: 100, y: 100, label: v };
  });
  return { nodes: nodes, edges: [] };
}

function checkWorkbook(xml, tag) {
  ok(xml.charCodeAt(0) === 0xfeff, tag + ": output starts with the BOM");
  ok(xml.indexOf("<Workbook") !== -1, tag + ": output is a Workbook");

  const cellOpens = xml.match(/<Cell>/g) || [];
  const stringCells = xml.match(/<Data ss:Type="String">/g) || [];
  ok(cellOpens.length > 0, tag + ": workbook contains cells");
  eq(stringCells.length, cellOpens.length,
    tag + ": every cell (" + cellOpens.length + ") is ss:Type=\"String\"");

  ok(xml.indexOf("ss:Formula") === -1, tag + ": no ss:Formula attribute anywhere");
  ok(!/ss:Type="(?!String")[^"]*"/.test(xml), tag + ": no non-String cell type");
}

function main() {
  const Tok = require(path.join(WEB, "executor/js/s1tokenize.js")); global.S1Tokenize = Tok;
  const U = require(path.join(WEB, "executor/js/s1util.js")); global.S1Util = U;
  const Exp = require(path.join(WEB, "executor/js/exporter.js"));
  const P = require(path.join(WEB, "import/engine/spreadsheetml-parser.js"));

  const state = fixture();

  /* ---- path 1: executor exporter (DMEngine absent -> local fallback) ---- */
  const checklist = VECTORS.slice(0, 3).map((v, i) => ({
    ref: "node:n" + (i + 1), kind: "node", node_id: "n" + (i + 1), label: v,
    detail: { type: "system", x: 100, y: 100 }, status: "unconfirmed",
  }));
  const confirmations = [{
    session_id: "s1", recipe_id: "=evil-recipe", item_index: 0,
    ref: "node:n1", label: VECTORS[0], note: "@note =1+1", by: "reviewer", at: "2026-10-05",
  }];
  const xml1 = Exp.buildDraftWorkbook(state, checklist, confirmations, "en");
  checkWorkbook(xml1, "executor exporter");

  /* hostile values from checklist and confirmations are inert too */
  eq((xml1.match(/ss:Formula/g) || []).length, 0, "review/confirmation sheets: no ss:Formula");

  /* ---- path 2: engine buildSpreadsheetML (the DMEngine branch) ---- */
  const xml2 = P.buildSpreadsheetML(state, "en");
  checkWorkbook(xml2, "engine buildSpreadsheetML");

  /* ---- XML escaping still holds for metacharacters ---- */
  const tricky = { nodes: { n1: { type: "system", x: 100, y: 100, label: "<b>&\"'=1+1" } }, edges: [] };
  const xml3 = Exp.buildDraftWorkbook(tricky, [], [], "en");
  ok(xml3.indexOf("&lt;b&gt;&amp;&quot;'=1+1") !== -1, "metacharacters are XML-escaped");
  ok(xml3.indexOf("<b>") === -1, "no raw markup leaks into the XML");

  /* ---- round trip: export -> parse -> state returns values verbatim ---- */
  for (const [xml, tag] of [[xml1, "executor exporter"], [xml2, "engine builder"]]) {
    const text = xml.replace(/^﻿/, "");
    const sheets = P.parseSpreadsheetML(text);
    ok(Array.isArray(sheets) && sheets.length > 0, tag + ": parser reads the workbook");
    const back = P.sheetsToState(sheets);
    const got = {};
    Object.keys(back.nodes).forEach((id) => { got[back.nodes[id].label] = true; });
    eq(Object.keys(back.nodes).length, VECTORS.length, tag + ": all rows round-trip");
    VECTORS.forEach((v) => {
      ok(got[v] === true, tag + ": value returns verbatim (inert text): " + JSON.stringify(v).slice(0, 40));
    });
  }

  console.log("PASS " + n + " [formula-injection]");
}

try {
  main();
} catch (e) {
  console.error("FAIL formula-injection: " + (e && e.stack || e));
  process.exitCode = 1;
}
