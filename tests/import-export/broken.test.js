/**
 * broken.test.js - broken-file handling across the import pipeline.
 *
 * Every corrupt input must produce structured errors, never throws, and no
 * partial state may leak into a later successful parse. Covers the parser
 * layer (parse-core), the SpreadsheetML parser, and the engine normalizer.
 *
 * Run: node broken.test.js   (from this directory)
 * No DOM, no network.
 */
"use strict";

global.self = global;
const assert = require("assert");

const ParseCore = require("../../web/import/worker/parse-core.js");
const XLSX = require("../../web/import/vendor/xlsx.full.min.js");
const { mapColumns } = require("../../web/import/engine/column-mapper.js");
const { toCanonicalModel } = require("../../web/import/engine/canonical-model.js");
const { validate } = require("../../web/import/engine/validate.js");
const { buildState } = require("../../web/import/engine/state-builder.js");
const { parseSpreadsheetML } = require("../../web/import/engine/spreadsheetml-parser.js");

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
function noEmDash(s, msg) {
  passed++;
  assert.ok(typeof s === "string" && !/\u2014/.test(s), msg || "error text must not contain an em dash");
}

function validSpreadsheetmlBytes() {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
    'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    '<Worksheet ss:Name="Nodes"><Table>' +
    '<Row><Cell><Data ss:Type="String">Label</Data></Cell><Cell><Data ss:Type="String">Type</Data></Cell></Row>' +
    '<Row><Cell><Data ss:Type="String">Shopify</Data></Cell><Cell><Data ss:Type="String">System</Data></Cell></Row>' +
    '</Table></Worksheet></Workbook>';
  return Buffer.from(xml, "utf8");
}

// Structured-error contract: failures return {ok:false, error} and never throw.
function expectRejection(name, buffer, filename) {
  t(name, () => {
    let res;
    try {
      res = ParseCore.parseFileBuffer(XLSX, buffer, filename);
    } catch (e) {
      throw new Error("threw instead of returning a structured error: " + (e && e.message));
    }
    passed++;
    eq(res.ok, false, "ok is false");
    passed++;
    deq(Object.keys(res).sort(), ["error", "ok"], "result has exactly {ok, error}");
    passed++;
    ok(typeof res.error === "string" && res.error.length > 0, "error is a non-empty string");
    noEmDash(res.error, "error text has no em dash");
    passed++;
    ok(res.sheets === undefined, "no partial sheets leak on failure");
  });
}

/* ------------------------------------------------------------------ */
/* corrupt inputs -> structured errors, no throws                       */
/* ------------------------------------------------------------------ */

expectRejection(
  "truncated zip with .xlsx name is rejected",
  Buffer.from("PK\x03\x04" + "x".repeat(40), "utf8"),
  "broken.xlsx"
);

expectRejection(
  "garbage bytes with .xlsx name are rejected",
  Buffer.from("this is not a workbook at all", "utf8"),
  "fake.xlsx"
);

expectRejection(
  "garbage bytes with .xls name are rejected",
  Buffer.from("this is not a workbook at all", "utf8"),
  "fake.xls"
);

t("the .csv extension is the documented tiebreaker: unrecognized bytes with a .csv name parse as CSV", () => {
  const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
  eq(ParseCore.detectFormat("binary.csv", bytes), "csv", "extension tiebreaker claims CSV");
  eq(ParseCore.detectFormat("binary", bytes), "unknown", "no extension means unknown");
  const res = ParseCore.parseFileBuffer(XLSX, bytes, "binary");
  eq(res.ok, false, "unknown input rejected with a structured error");
  noEmDash(res.error, "error text has no em dash");
});

expectRejection("empty buffer is rejected", new Uint8Array(0), "empty.csv");
expectRejection("null buffer is rejected", null, "null.csv");
expectRejection("BOM-only buffer is rejected", Buffer.from([0xef, 0xbb, 0xbf]), "bom.csv");
expectRejection("whitespace-only buffer with no extension is rejected", Buffer.from("   \n\t\n", "utf8"), "blank");

expectRejection(
  "truncated SpreadsheetML (no closing Workbook) is rejected",
  Buffer.from(
    '<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet">' +
    '<Worksheet ss:Name="Nodes"><Table>' +
    '<Row><Cell><Data ss:Type="String">Label</Data></Cell></Row>',
    "utf8"
  ),
  "cut.xls"
);

expectRejection(
  "SpreadsheetML with no worksheets is rejected",
  Buffer.from(
    '<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"></Workbook>',
    "utf8"
  ),
  "noworksheets.xls"
);

expectRejection(
  "fake OLE header (legacy .xls magic, random body) is rejected",
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x11, 0x22, 0x33]),
  "legacy.xls"
);

expectRejection(
  "workbook with one sheet but zero rows is rejected",
  (() => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "Empty");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  })(),
  "empty.xlsx"
);

t("a one-blank-row sheet parses but maps to unknown with a sheet-level rejection", () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[""]]), "Blank");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const res = ParseCore.parseFileBuffer(XLSX, buf, "blank.xlsx");
  eq(res.ok, true, "SheetJS-level parse succeeds");
  const mapped = mapColumns(res.sheets[0]);
  eq(mapped.kind, "unknown", "blank sheet is unknown");
  eq(mapped.confidence, 0, "zero confidence");
  const model = toCanonicalModel(mapped, res.sheets[0].rows);
  eq(model.systems.length, 0, "no systems");
  eq(model.flows.length, 0, "no flows");
  eq(model.rejected.length, 1, "one sheet-level rejection");
  eq(model.rejected[0].kind, "sheet", "rejection names the sheet");
  ok(/not importable/.test(model.rejected[0].reason), "rejection reason is plain language");
});

/* ------------------------------------------------------------------ */
/* no partial state leaks between parses                               */
/* ------------------------------------------------------------------ */

t("a failed parse leaves no residue in the next successful parse", () => {
  const bad = ParseCore.parseFileBuffer(XLSX, Buffer.from("garbage", "utf8"), "bad.xlsx");
  eq(bad.ok, false, "first parse fails");
  const good = ParseCore.parseFileBuffer(XLSX, validSpreadsheetmlBytes(), "good.xls");
  eq(good.ok, true, "second parse succeeds");
  eq(good.sheets.length, 1, "exactly one sheet");
  eq(good.sheets[0].name, "Nodes", "sheet name from the good file only");
  deq(good.sheets[0].rows[1], ["Shopify", "System"], "rows from the good file only");
});

t("two failures in a row stay independent", () => {
  const r1 = ParseCore.parseFileBuffer(XLSX, Buffer.from("PK\x03\x04zz", "utf8"), "a.xlsx");
  const r2 = ParseCore.parseFileBuffer(XLSX, new Uint8Array(0), "b.csv");
  eq(r1.ok, false, "first fails");
  eq(r2.ok, false, "second fails");
  ok(r1.error !== r2.error, "each failure carries its own error text");
});

/* ------------------------------------------------------------------ */
/* SpreadsheetML parser never throws on malformed XML                  */
/* ------------------------------------------------------------------ */

t("parseSpreadsheetML on malformed XML returns an array, never throws", () => {
  const badInputs = [
    "",
    "not xml at all",
    "<Workbook><Worksheet><Row><Cell>unclosed",
    "<Workbook></Workbook>",
    "<Worksheet ss:Name=\"Nodes\"><Table><Row><Cell><Data>hi",
    "\uFEFF",
  ];
  for (const input of badInputs) {
    let out;
    try {
      out = parseSpreadsheetML(input);
    } catch (e) {
      throw new Error("threw on " + JSON.stringify(input.slice(0, 30)) + ": " + (e && e.message));
    }
    passed++;
    ok(Array.isArray(out), "array for " + JSON.stringify(input.slice(0, 30)));
  }
});

t("parseSpreadsheetML drops a truncated final row but keeps complete rows", () => {
  const xml =
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet">' +
    '<Worksheet ss:Name="Nodes"><Table>' +
    '<Row><Cell><Data ss:Type="String">Label</Data></Cell><Cell><Data ss:Type="String">Type</Data></Cell></Row>' +
    '<Row><Cell><Data ss:Type="String">A</Data></Cell><Cell><Data ss:Type="String">System</Data></Cell></Row>' +
    '<Row><Cell><Data ss:Type="String">B</Data></Cell>' + // truncated mid-row
    '</Table></Worksheet></Workbook>';
  const sheets = parseSpreadsheetML(xml);
  eq(sheets.length, 1, "worksheet still found");
  eq(sheets[0].rows.length, 2, "complete rows recovered, truncated row dropped");
  deq(sheets[0].rows[1], ["A", "System"], "recovered row intact");
});

t("parseSpreadsheetML yields zero sheets when the Worksheet tag never closes", () => {
  const xml =
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet">' +
    '<Worksheet ss:Name="Nodes"><Table>' +
    '<Row><Cell><Data ss:Type="String">Label</Data></Cell></Row>';
  const sheets = parseSpreadsheetML(xml);
  deq(sheets, [], "unclosed worksheet is not half-parsed");
});

/* ------------------------------------------------------------------ */
/* engine normalizer on corrupt rows: reject, never crash               */
/* ------------------------------------------------------------------ */

t("toCanonicalModel rejects garbage rows without throwing", () => {
  const sheet = {
    name: "TEMPLATE - Systems",
    rows: [
      ["System / application name", "Type", "Data categories", "Purposes of use", "Lawful basis", "Retention period", "Storage location", "Owner / department", "Notes"],
      ["", "System", "d", "u", "Consent", "7y", "Quebec", "Ops", ""],      // blank name
      ["Mystery box", "Data lake thing", "d", "u", "Consent", "7y", "Quebec", "Ops", ""], // unknown type
      ["No type at all", "", "d", "u", "Consent", "7y", "Quebec", "Ops", ""],             // blank type
      ["", "", "", "", "", "", "", "", ""],                              // fully blank row (skipped silently)
      ["Good system", "System", "d", "u", "Consent", "7y", "Quebec", "Ops", ""],
    ],
  };
  const mapped = mapColumns(sheet);
  eq(mapped.kind, "template-systems", "kind detected");
  let model;
  try {
    model = toCanonicalModel(mapped, sheet.rows);
  } catch (e) {
    throw new Error("toCanonicalModel threw: " + (e && e.message));
  }
  passed++;
  eq(model.systems.length, 1, "only the good row survives");
  eq(model.systems[0].name, "Good system", "survivor is the good row");
  eq(model.rejected.length, 3, "three rejections recorded");
  ok(model.rejected.every((r) => typeof r.row === "number" && typeof r.reason === "string"), "rejections carry row + reason");
  ok(model.rejected.every((r) => !/\u2014/.test(r.reason)), "rejection reasons have no em dashes");
  const reasons = model.rejected.map((r) => r.reason).join(" ");
  ok(/no system name/i.test(reasons), "blank name reason present");
  ok(/not a known type/i.test(reasons), "unknown type reason present");
  ok(/no type/i.test(reasons), "blank type reason present");
});

t("toCanonicalModel rejects flows missing From/To with the row identified", () => {
  const sheet = {
    name: "TEMPLATE - Data flows",
    rows: [
      ["From (system)", "To (system)", "Data categories transferred", "Purpose of transfer", "Cross-border?", "Destination", "Safeguards", "Notes"],
      ["", "Klaviyo", "data", "sync", "No", "", "", ""],   // missing From
      ["Shopify", "", "data", "sync", "No", "", "", ""],   // missing To
      ["", "", "data", "sync", "No", "", "", ""],          // missing both
      ["Shopify", "Klaviyo", "data", "sync", "No", "", "", ""],
    ],
  };
  const mapped = mapColumns(sheet);
  const model = toCanonicalModel(mapped, sheet.rows);
  eq(model.flows.length, 1, "only the complete flow survives");
  eq(model.rejected.length, 3, "three flow rejections");
  ok(model.rejected.every((r) => r.kind === "flow"), "all rejections are flow-kind");
  deq(model.rejected.map((r) => r.row), [2, 3, 4], "rejections name the exact 1-based rows");
});

t("buildState never crashes on a model full of rejected rows", () => {
  const model = { systems: [], flows: [], rejected: [{ row: 2, kind: "system", reason: "x" }] };
  let state;
  try {
    state = buildState(model, { categories: {} });
  } catch (e) {
    throw new Error("buildState threw: " + (e && e.message));
  }
  passed++;
  deq(state.nodes, {}, "empty nodes");
  deq(state.edges, [], "empty edges");
  eq(state.seq, 0, "seq zero");
});

t("validate never crashes on empty or malformed model shapes", () => {
  for (const model of [{}, { systems: null, flows: null }, { systems: [], flows: [] }]) {
    let flags;
    try {
      flags = validate(model);
    } catch (e) {
      throw new Error("validate threw: " + (e && e.message));
    }
    passed++;
    deq(flags, [], "empty model validates clean");
  }
});

/* ------------------------------------------------------------------ */

if (failures.length) {
  for (const f of failures) console.error("FAIL " + f);
  console.error("FAILED " + failures.length + " test(s), " + passed + " assertion(s) passed before failure");
  process.exitCode = 1;
} else {
  console.log("PASS " + passed);
}
