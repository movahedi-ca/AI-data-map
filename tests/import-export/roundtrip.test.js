/**
 * roundtrip.test.js - import pipeline round-trips.
 *
 * Parse real-format fixtures (binary .xlsx via the vendored SheetJS build,
 * SpreadsheetML text, CSV text), normalize to the canonical model, serialize
 * back to SpreadsheetML, re-parse, and assert the second parse equals the
 * first (byte-level determinism plus deep-equal on the parsed shapes).
 *
 * Run: node roundtrip.test.js   (from this directory)
 * No DOM, no network.
 */
"use strict";

global.self = global;
const assert = require("assert");

const ParseCore = require("../../web/import/worker/parse-core.js");
const XLSX = require("../../web/import/vendor/xlsx.full.min.js");
const { mapColumns, splitSections } = require("../../web/import/engine/column-mapper.js");
const { toCanonicalModel } = require("../../web/import/engine/canonical-model.js");
const { validate } = require("../../web/import/engine/validate.js");
const { buildState } = require("../../web/import/engine/state-builder.js");
const {
  parseSpreadsheetML,
  buildSpreadsheetML,
  sheetsToState,
  findInventorySheets,
} = require("../../web/import/engine/spreadsheetml-parser.js");

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
function noThrow(fn, msg) { passed++; assert.doesNotThrow(fn, msg); }

/* ------------------------------------------------------------------ */
/* fixtures: the real shipped template shape (verified 2026-10-04)     */
/* ------------------------------------------------------------------ */

const SYSTEMS_HEADERS = [
  "System / application name", "Type", "Data categories", "Purposes of use",
  "Lawful basis", "Retention period", "Storage location", "Owner / department", "Notes",
];
const FLOWS_HEADERS = [
  "From (system)", "To (system)", "Data categories transferred", "Purpose of transfer",
  "Cross-border?", "Destination", "Safeguards", "Notes",
];
const SYSTEMS_DATA = [
  ["Website checkout form", "Collection point", "customer data, payment info", "Process online orders", "Consent", "Transaction + 7 years (tax law)", "Quebec", "E-commerce", ""],
  ["POS terminals (Square)", "Collection point", "customer data, payment info", "In-store sales", "Contract", "7 years (tax law)", "Canada", "Retail ops", ""],
  ["Shopify", "Internal system", "customer data, order history", "Order management", "Contract", "7 years (tax law)", "Canada", "E-commerce", ""],
  ["Klaviyo", "Third party", "marketing consents, customer data", "Email marketing", "Consent", "Until consent withdrawn + 3 years", "United States", "Marketing", "Cross-border assessment filed Mar 2026"],
];
const FLOWS_DATA = [
  ["Website checkout form", "Shopify", "customer data, payment info", "Order processing", "No", "", "TLS in transit", ""],
  ["Shopify", "Klaviyo", "customer data, marketing consents", "Email campaigns", "Yes", "United States", "DPA + SCCs; assessment filed", ""],
];

// Real binary .xlsx built with the vendored SheetJS build.
function templateXlsxBytes() {
  const wb = XLSX.utils.book_new();
  const sysRows = [["TEMPLATE - fill in your own systems below."], SYSTEMS_HEADERS, ...SYSTEMS_DATA];
  const flowRows = [["TEMPLATE - fill in your own data flows below."], FLOWS_HEADERS, ...FLOWS_DATA];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sysRows), "TEMPLATE - Systems");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(flowRows), "TEMPLATE - Data flows");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function fullPipeline(parsedSheets) {
  const kinds = parsedSheets.map((s) => mapColumns(s));
  const models = parsedSheets.map((s, i) => toCanonicalModel(kinds[i], s.rows));
  const systems = models.flatMap((m) => m.systems);
  const flows = models.flatMap((m) => m.flows);
  const rejected = models.flatMap((m) => m.rejected);
  return { kinds, systems, flows, rejected };
}

/* ------------------------------------------------------------------ */
/* A. binary .xlsx template round trip                                 */
/* ------------------------------------------------------------------ */

t("xlsx: detects format and parses both template sheets", () => {
  const res = ParseCore.parseFileBuffer(XLSX, templateXlsxBytes(), "template.xlsx");
  eq(res.ok, true, "parse ok");
  eq(res.format, "xlsx", "format xlsx");
  eq(res.sheets.length, 2, "two sheets");
  eq(res.sheets[0].rows[1][0], "System / application name", "systems header survives binary parse");
  eq(res.sheets[1].rows[1][0], "From (system)", "flows header survives binary parse");
  eq(res.sheets[0].rows.length, 6, "4 data rows + instruction + header");
});

t("xlsx: full pipeline to guide state is clean", () => {
  const res = ParseCore.parseFileBuffer(XLSX, templateXlsxBytes(), "template.xlsx");
  const { kinds, systems, flows, rejected } = fullPipeline(res.sheets);
  deq(kinds.map((k) => k.kind), ["template-systems", "template-flows"], "sheet kinds");
  ok(kinds.every((k) => k.confidence === 1.0), "confidence 1.0 on the real template");
  eq(systems.length, 4, "4 systems");
  eq(flows.length, 2, "2 flows");
  deq(rejected, [], "nothing rejected");
  const flags = validate({ systems, flows });
  ok(flags.every((f) => f.severity === "warning"), "only warnings (category confirmation)");
  ok(flags.every((f) => f.code === "MISSING_CATEGORY"), "warnings are all MISSING_CATEGORY");
});

t("xlsx: buildSpreadsheetML is byte-deterministic", () => {
  const res = ParseCore.parseFileBuffer(XLSX, templateXlsxBytes(), "template.xlsx");
  const { systems, flows } = fullPipeline(res.sheets);
  const confirmed = { categories: {} };
  flows.forEach((f, i) => { confirmed.categories[i] = f.proposedCategory.cat; });
  const state = buildState({ systems, flows }, confirmed);
  eq(Object.keys(state.nodes).length, 4, "4 nodes placed");
  eq(state.edges.length, 2, "2 edges drawn");
  const xml1 = buildSpreadsheetML(state, "en");
  const xml2 = buildSpreadsheetML(state, "en");
  eq(xml1, xml2, "two builds of the same state produce identical bytes");
  ok(xml1.charCodeAt(0) === 0xfeff, "BOM first");
});

t("xlsx: parse(parse(build(state))) equals parse(build(state))", () => {
  const res = ParseCore.parseFileBuffer(XLSX, templateXlsxBytes(), "template.xlsx");
  const { systems, flows } = fullPipeline(res.sheets);
  const confirmed = { categories: {} };
  flows.forEach((f, i) => { confirmed.categories[i] = f.proposedCategory.cat; });
  const state = buildState({ systems, flows }, confirmed);
  const xml = buildSpreadsheetML(state, "en");
  const sheets1 = parseSpreadsheetML(xml);
  const sheets2 = parseSpreadsheetML(xml);
  deq(sheets2, sheets1, "second parse deep-equals the first parse");
  const xmlAgain = buildSpreadsheetML(state, "en");
  deq(parseSpreadsheetML(xmlAgain), sheets1, "re-serialized then re-parsed still equal");
});

t("xlsx: round-trip restores every node and edge", () => {
  const res = ParseCore.parseFileBuffer(XLSX, templateXlsxBytes(), "template.xlsx");
  const { systems, flows } = fullPipeline(res.sheets);
  const confirmed = { categories: {} };
  flows.forEach((f, i) => { confirmed.categories[i] = f.proposedCategory.cat; });
  const stateA = buildState({ systems, flows }, confirmed);
  const sheets = parseSpreadsheetML(buildSpreadsheetML(stateA, "en"));
  const { kinds } = { kinds: sheets.map((s) => mapColumns(s)) };
  deq(kinds.map((k) => k.kind).sort(), ["exporter-connections", "exporter-nodes"], "re-import kinds");
  ok(kinds.every((k) => k.confidence === 1.0), "re-import confidence 1.0");
  const models = sheets.map((s, i) => toCanonicalModel(kinds[i], s.rows));
  const systemsB = models.flatMap((m) => m.systems);
  const flowsB = models.flatMap((m) => m.flows);
  eq(systemsB.length, 4, "4 systems restored");
  eq(flowsB.length, 3 - 1, "2 flows restored");
  const flags = validate({ systems: systemsB, flows: flowsB });
  deq(flags, [], "no validation flags on the round-tripped model");
  const stateB = buildState({ systems: systemsB, flows: flowsB }, { categories: {} });
  deq(stateB.nodes, stateA.nodes, "nodes identical after round trip");
  deq(stateB.edges, stateA.edges, "edges identical after round trip");
  deq(stateB.rejected, [], "nothing rejected on round trip");
});

/* ------------------------------------------------------------------ */
/* B. SpreadsheetML text fixture round trip                            */
/* ------------------------------------------------------------------ */

function spreadsheetmlFixture() {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n' +
    ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
    '<Worksheet ss:Name="Nodes"><Table>\n' +
    '<Row><Cell><Data ss:Type="String">DRAFT: working draft. Not legal advice.</Data></Cell></Row>\n' +
    '<Row><Cell><Data ss:Type="String"></Data></Cell></Row>\n' +
    '<Row><Cell><Data ss:Type="String">Label</Data></Cell><Cell><Data ss:Type="String">Type</Data></Cell></Row>\n' +
    '<Row><Cell><Data ss:Type="String">Checkout form</Data></Cell><Cell><Data ss:Type="String">Collection point</Data></Cell></Row>\n' +
    '<Row><Cell><Data ss:Type="String">Shopify</Data></Cell><Cell><Data ss:Type="String">System</Data></Cell></Row>\n' +
    '<Row><Cell><Data ss:Type="String">Klaviyo</Data></Cell><Cell><Data ss:Type="String">Third party</Data></Cell></Row>\n' +
    '<Row><Cell><Data ss:Type="String">Old backups</Data></Cell><Cell><Data ss:Type="String">Secure destruction</Data></Cell></Row>\n' +
    '</Table></Worksheet>\n' +
    '<Worksheet ss:Name="Connections"><Table>\n' +
    '<Row><Cell><Data ss:Type="String">From</Data></Cell><Cell><Data ss:Type="String">To</Data></Cell><Cell><Data ss:Type="String">Category</Data></Cell></Row>\n' +
    '<Row><Cell><Data ss:Type="String">Checkout form</Data></Cell><Cell><Data ss:Type="String">Shopify</Data></Cell><Cell><Data ss:Type="String">Payment</Data></Cell></Row>\n' +
    '<Row><Cell><Data ss:Type="String">Shopify</Data></Cell><Cell><Data ss:Type="String">Klaviyo</Data></Cell><Cell><Data ss:Type="String">Marketing / consent</Data></Cell></Row>\n' +
    '<Row><Cell><Data ss:Type="String">Shopify</Data></Cell><Cell><Data ss:Type="String">Old backups</Data></Cell><Cell><Data ss:Type="String">Contact / identity</Data></Cell></Row>\n' +
    '</Table></Worksheet>\n' +
    '</Workbook>';
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml, "utf8")]);
}

t("spreadsheetml: content-sniffed import normalizes cleanly", () => {
  const res = ParseCore.parseFileBuffer(XLSX, spreadsheetmlFixture(), "data-map-inventory.xls");
  eq(res.ok, true, "parse ok");
  eq(res.format, "spreadsheetml", "content-first detection");
  const { systems, flows, rejected } = fullPipeline(res.sheets);
  eq(systems.length, 4, "4 systems");
  eq(flows.length, 3, "3 flows");
  deq(rejected, [], "nothing rejected");
  const flags = validate({ systems, flows });
  deq(flags, [], "zero flags: categories came from display names");
  deq(flows.map((f) => f.edgeCategory), ["payment", "marketing", "contact"], "categories resolved");
});

t("spreadsheetml: serialize, re-parse, second parse equals first", () => {
  const res = ParseCore.parseFileBuffer(XLSX, spreadsheetmlFixture(), "data-map-inventory.xls");
  const { systems, flows } = fullPipeline(res.sheets);
  const stateA = buildState({ systems, flows }, { categories: {} });
  eq(stateA.edges.length, 3, "3 edges drawn (categories were in the file)");
  const xml = buildSpreadsheetML(stateA, "en");
  const first = parseSpreadsheetML(xml);
  const second = parseSpreadsheetML(buildSpreadsheetML(stateA, "en"));
  deq(second, first, "second parse equals first");
  const inv = findInventorySheets(first);
  ok(inv.nodes && inv.connections, "inventory sheets found");
  const recovered = sheetsToState(first);
  eq(recovered.seq, 4, "4 nodes recovered");
  const labelsA = Object.values(stateA.nodes).map((n) => n.label).sort();
  const labelsB = Object.values(recovered.nodes).map((n) => n.label).sort();
  deq(labelsB, labelsA, "labels restored");
  const typesB = {};
  for (const n of Object.values(recovered.nodes)) typesB[n.label] = n.type;
  eq(typesB["Checkout form"], "collection", "type restored");
  eq(typesB["Old backups"], "destruction", "destruction type restored");
  const catsB = recovered.edges.map((e) => e.cat).sort();
  deq(catsB, ["contact", "marketing", "payment"], "edge categories restored");
});

/* ------------------------------------------------------------------ */
/* C. CSV fixture round trip                                           */
/* ------------------------------------------------------------------ */

t("csv: systems + flows CSV files round-trip through the pipeline", () => {
  const sysCsv = Buffer.from(
    "\uFEFF" + SYSTEMS_HEADERS.join(",") + "\n" +
    SYSTEMS_DATA.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n") + "\n",
    "utf8"
  );
  const flowCsv = Buffer.from(
    FLOWS_HEADERS.join(",") + "\n" +
    FLOWS_DATA.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n") + "\n",
    "utf8"
  );
  const rs = ParseCore.parseFileBuffer(XLSX, sysCsv, "systems.csv");
  const rf = ParseCore.parseFileBuffer(XLSX, flowCsv, "flows.csv");
  eq(rs.ok && rf.ok, true, "both CSVs parse");
  eq(rs.format, "csv", "csv format");
  const { systems } = fullPipeline(rs.sheets);
  const { flows } = fullPipeline(rf.sheets);
  eq(systems.length, 4, "4 systems from CSV");
  eq(flows.length, 2, "2 flows from CSV");
  eq(systems[3].name, "Klaviyo", "BOM stripped, name intact");
  eq(systems[3].notes, "Cross-border assessment filed Mar 2026", "quoted comma field intact");
  const confirmed = { categories: {} };
  flows.forEach((f, i) => { confirmed.categories[i] = f.proposedCategory.cat; });
  const stateA = buildState({ systems, flows }, confirmed);
  const first = parseSpreadsheetML(buildSpreadsheetML(stateA, "en"));
  const second = parseSpreadsheetML(buildSpreadsheetML(stateA, "en"));
  deq(second, first, "CSV-sourced state round-trips identically");
  const stateB = buildState(
    (() => {
      const kinds = first.map((s) => mapColumns(s));
      const ms = first.map((s, i) => toCanonicalModel(kinds[i], s.rows));
      return { systems: ms.flatMap((m) => m.systems), flows: ms.flatMap((m) => m.flows) };
    })(),
    { categories: {} }
  );
  deq(stateB.nodes, stateA.nodes, "CSV nodes identical after round trip");
  deq(stateB.edges, stateA.edges, "CSV edges identical after round trip");
});

/* ------------------------------------------------------------------ */
/* D. FR exporter round trip                                           */
/* ------------------------------------------------------------------ */

const FR_STATE = {
  nodes: {
    n1: { type: "collection", x: 80, y: 80, label: "Formulaire" },
    n2: { type: "system", x: 310, y: 80, label: "Compta" },
    n3: { type: "thirdparty", x: 545, y: 80, label: "Infolettre" },
    n4: { type: "destruction", x: 310, y: 340, label: "Vieilles sauvegardes" },
  },
  edges: [
    { a: "n1", b: "n2", cat: "payment" },
    { a: "n2", b: "n3", cat: "marketing" },
    { a: "n2", b: "n4", cat: "contact" },
  ],
  seq: 4,
};

t("fr: exporter round-trips every type and category display name", () => {
  const xml = buildSpreadsheetML(FR_STATE, "fr");
  const first = parseSpreadsheetML(xml);
  const second = parseSpreadsheetML(buildSpreadsheetML(FR_STATE, "fr"));
  deq(second, first, "FR second parse equals first");
  const kinds = first.map((s) => mapColumns(s));
  deq(kinds.map((k) => k.kind).sort(), ["exporter-connections", "exporter-nodes"], "FR kinds");
  ok(kinds.every((k) => k.confidence === 1.0), "FR confidence 1.0");
  const models = first.map((s, i) => toCanonicalModel(kinds[i], s.rows));
  const systems = models.flatMap((m) => m.systems);
  const flows = models.flatMap((m) => m.flows);
  eq(systems.length, 4, "4 FR systems");
  eq(flows.length, 3, "3 FR flows");
  const byLabel = {};
  for (const s of systems) byLabel[s.name] = s.type;
  eq(byLabel["Formulaire"], "collection", "FR collection type");
  eq(byLabel["Compta"], "system", "FR system type");
  eq(byLabel["Infolettre"], "thirdparty", "FR thirdparty type");
  eq(byLabel["Vieilles sauvegardes"], "destruction", "FR destruction type");
  deq(flows.map((f) => f.edgeCategory).sort(), ["contact", "marketing", "payment"], "FR categories");
  const flags = validate({ systems, flows });
  deq(flags, [], "FR round trip is flag-free");
  const stateB = buildState({ systems, flows }, { categories: {} });
  eq(stateB.edges.length, 3, "FR 3 edges drawn");
  deq(stateB.rejected, [], "FR nothing rejected");
});

t("fr: parse-core sniffs and imports the FR export by content", () => {
  const xml = buildSpreadsheetML(FR_STATE, "fr");
  const bytes = Buffer.from(xml, "utf8");
  const res = ParseCore.parseFileBuffer(XLSX, bytes, "export.xls");
  eq(res.ok, true, "parse ok");
  eq(res.format, "spreadsheetml", "content-first detection on FR export");
  const kinds = res.sheets.map((s) => mapColumns(s));
  ok(kinds.every((k) => k.confidence === 1.0), "mapper confidence 1.0 via SheetJS path too");
});

/* ------------------------------------------------------------------ */
/* E. stacked EXAMPLE sheet round trip                                 */
/* ------------------------------------------------------------------ */

t("stacked: EXAMPLE sheet with SYSTEMS/DATA FLOWS sections round-trips", () => {
  const rows = [
    ["EXAMPLE 2 - SaaS startup"],
    ["SYSTEMS"],
    SYSTEMS_HEADERS,
    ...SYSTEMS_DATA,
    [""],
    ["DATA FLOWS"],
    FLOWS_HEADERS,
    ...FLOWS_DATA,
  ];
  const parts = splitSections({ name: "EXAMPLE 2 - SaaS startup", rows });
  eq(parts.length, 2, "split into two sections");
  const { systems, flows, rejected } = fullPipeline(parts);
  eq(systems.length, 4, "4 systems from stacked sheet");
  eq(flows.length, 2, "2 flows from stacked sheet");
  deq(rejected, [], "nothing rejected");
  const confirmed = { categories: {} };
  flows.forEach((f, i) => { confirmed.categories[i] = f.proposedCategory.cat; });
  const stateA = buildState({ systems, flows }, confirmed);
  const first = parseSpreadsheetML(buildSpreadsheetML(stateA, "en"));
  deq(parseSpreadsheetML(buildSpreadsheetML(stateA, "en")), first, "stacked-sourced second parse equals first");
  eq(first.length, 2, "two inventory sheets out");
});

/* ------------------------------------------------------------------ */
/* F. unicode and punctuation-heavy labels survive the round trip       */
/* ------------------------------------------------------------------ */

t("unicode: labels with entities, quotes, accents, and CJK round-trip", () => {
  const state = {
    nodes: {
      n1: { type: "collection", x: 80, y: 80, label: "R&D <core> & \"syst\u00e8mes\" caf\u00e9" },
      n2: { type: "system", x: 310, y: 80, label: "\u5317\u4eac\u6570\u636e\u5e93" },
      n3: { type: "thirdparty", x: 545, y: 80, label: "O'Brien & Sons, Ltd." },
    },
    edges: [{ a: "n1", b: "n2", cat: "contact" }, { a: "n2", b: "n3", cat: "payment" }],
    seq: 3,
  };
  const xml = buildSpreadsheetML(state, "en");
  noThrow(() => parseSpreadsheetML(xml), "entity-heavy XML parses without throwing");
  const recovered = sheetsToState(parseSpreadsheetML(xml));
  const got = Object.values(recovered.nodes).map((n) => n.label).sort();
  const want = Object.values(state.nodes).map((n) => n.label).sort();
  deq(got, want, "every label byte-identical after the round trip");
  ok(!/<core>/.test(xml.replace(/&lt;core&gt;/g, "")), "angle brackets escaped in the raw XML");
});

/* ------------------------------------------------------------------ */

if (failures.length) {
  for (const f of failures) console.error("FAIL " + f);
  console.error("FAILED " + failures.length + " test(s), " + passed + " assertion(s) passed before failure");
  process.exitCode = 1;
} else {
  console.log("PASS " + passed);
}
