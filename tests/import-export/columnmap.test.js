/**
 * columnmap.test.js - column mapping edge cases.
 *
 * Extends engine.test.js (which covers the happy paths: real template headers,
 * exporter EN/FR sheets, unknown headers, section splitting). New cases here:
 * partial headers with fractional confidence, extra columns, shuffled column
 * order mapping to canonical field names, FR template aliases, deep header
 * rows, repeated section markers, the header-signature fast path without the
 * sheet-name signal, and the frozen COLUMN_SETS contract.
 *
 * Run: node columnmap.test.js   (from this directory)
 * No DOM, no network.
 */
"use strict";

global.self = global;
const assert = require("assert");

const { mapColumns, splitSections, findHeaderRow, normalizeHeader, COLUMN_SETS } =
  require("../../web/import/engine/column-mapper.js");
const { toCanonicalModel } = require("../../web/import/engine/canonical-model.js");

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
/* frozen contract                                                      */
/* ------------------------------------------------------------------ */

t("COLUMN_SETS carries the frozen field contracts", () => {
  deq(COLUMN_SETS["template-systems"], [
    "systemName", "type", "dataCategories", "purposes",
    "lawfulBasis", "retention", "storageLocation", "owner", "notes",
  ], "9 systems fields");
  deq(COLUMN_SETS["template-flows"], [
    "from", "to", "dataCategories", "purpose",
    "crossBorder", "destination", "safeguards", "notes",
  ], "8 flows fields");
  deq(COLUMN_SETS["exporter-nodes"], ["label", "type"], "nodes fields");
  deq(COLUMN_SETS["exporter-connections"], ["from", "to", "category"], "connections fields");
});

/* ------------------------------------------------------------------ */
/* partial headers                                                      */
/* ------------------------------------------------------------------ */

t("partial systems headers map with fractional confidence", () => {
  const rows = [
    ["System / application name", "Type", "Data categories", "Purposes of use", "Lawful basis"],
    ["Shopify", "System", "data", "use", "Consent"],
  ];
  const r = mapColumns({ name: "Systems", rows });
  eq(r.kind, "template-systems", "kind still detected");
  eq(r.confidence, 5 / 9, "confidence is matched / fields");
  eq(r.headerRow, 0, "header at row 0");
  deq(r.unmappedHeaders, [], "no unmapped headers");
  deq(r.mapping, { systemName: 0, type: 1, dataCategories: 2, purposes: 3, lawfulBasis: 4 }, "mapping exact");
  const model = toCanonicalModel(r, rows);
  eq(model.systems.length, 1, "row still normalizes");
  eq(model.systems[0].retention, "", "unmapped fields arrive empty, never undefined");
  eq(model.systems[0].notes, "", "unmapped notes empty");
});

t("partial flows headers map with fractional confidence", () => {
  const rows = [
    ["From (system)", "To (system)", "Purpose of transfer"],
    ["A", "B", "sync"],
  ];
  const r = mapColumns({ name: "Data flows", rows });
  eq(r.kind, "template-flows", "kind detected");
  eq(r.confidence, 3 / 8, "3 of 8 matched");
  deq(r.mapping, { from: 0, to: 1, purpose: 2 }, "mapping exact");
});

t("extra unknown columns land in unmappedHeaders and keep confidence honest", () => {
  const rows = [
    ["System / application name", "Type", "Data categories", "Purposes of use", "Lawful basis",
     "Retention period", "Storage location", "Owner / department", "Notes", "Internal code", "Reviewed?"],
    ["Shopify", "System", "data", "use", "Consent", "7y", "Canada", "Ops", "", "X1", "Yes"],
  ];
  const r = mapColumns({ name: "Systems", rows });
  eq(r.kind, "template-systems", "kind detected");
  eq(r.confidence, 1.0, "all 9 known fields matched");
  deq(r.unmappedHeaders, ["internal code", "reviewed?"], "unknown columns listed, normalized");
  eq(r.mapping.systemName, 0, "known columns map by position");
  eq(r.mapping.notes, 8, "notes still index 8");
});

t("too few matching headers means unknown, not a wrong guess", () => {
  const rows = [["Type", "Something else"], ["System", "x"]];
  const r = mapColumns({ name: "Mystery", rows });
  eq(r.kind, "unknown", "one match is not enough for a template kind");
  eq(r.confidence, 0, "zero confidence");
});

/* ------------------------------------------------------------------ */
/* shuffled columns -> canonical field names                            */
/* ------------------------------------------------------------------ */

t("shuffled column order still lands values on the canonical fields", () => {
  const rows = [
    ["Notes", "Owner / department", "Type", "System / application name"],
    ["a note", "Marketing", "Third party", "Klaviyo"],
  ];
  const r = mapColumns({ name: "Systems", rows });
  eq(r.kind, "template-systems", "kind detected");
  deq(r.mapping, { notes: 0, owner: 1, type: 2, systemName: 3 }, "mapping follows the header positions");
  const model = toCanonicalModel(r, rows);
  eq(model.systems.length, 1, "one system");
  eq(model.systems[0].name, "Klaviyo", "name from column 3");
  eq(model.systems[0].type, "thirdparty", "type from column 2");
  eq(model.systems[0].owner, "Marketing", "owner from column 1");
  eq(model.systems[0].notes, "a note", "notes from column 0");
});

t("shuffled flows columns map from/to correctly", () => {
  const rows = [
    ["Purpose of transfer", "To (system)", "From (system)"],
    ["sync", "Klaviyo", "Shopify"],
  ];
  const r = mapColumns({ name: "Data flows", rows });
  deq(r.mapping, { purpose: 0, to: 1, from: 2 }, "mapping follows positions");
  const model = toCanonicalModel(r, rows);
  eq(model.flows[0].from, "Shopify", "from from column 2");
  eq(model.flows[0].to, "Klaviyo", "to from column 1");
  eq(model.flows[0].purpose, "sync", "purpose from column 0");
});

/* ------------------------------------------------------------------ */
/* FR template aliases                                                  */
/* ------------------------------------------------------------------ */

t("FR template aliases map to the canonical fields", () => {
  const rows = [
    ["Nom du systeme", "Type de noeud", "Categories de donnees", "Fins d'utilisation", "Fondement juridique", "Conservation", "Emplacement", "Responsable", "Commentaires"],
    ["Boutique", "Point de collecte", "donnees", "ventes", "Consentement", "7 ans", "Quebec", "Ventes", ""],
  ];
  const r = mapColumns({ name: "Systemes", rows });
  eq(r.kind, "template-systems", "FR aliases detected");
  eq(r.confidence, 1.0, "full FR match");
  deq(r.mapping.systemName, 0, "nom du systeme -> systemName");
  deq(r.mapping.type, 1, "type de noeud -> type");
  deq(r.mapping.dataCategories, 2, "categories de donnees -> dataCategories");
  deq(r.mapping.purposes, 3, "fins d'utilisation -> purposes");
  const model = toCanonicalModel(r, rows);
  eq(model.systems[0].name, "Boutique", "FR name normalizes");
});

t("FR flows aliases map to the canonical fields", () => {
  const rows = [
    ["De", "Vers", "Donnees transferees", "Objet du transfert", "Transfrontalier", "Pays de destination", "Garanties"],
    ["A", "B", "donnees", "sync", "Oui", "Etats-Unis", "DPA"],
  ];
  const r = mapColumns({ name: "Flux", rows });
  eq(r.kind, "template-flows", "FR flows aliases detected");
  deq(r.mapping, { from: 0, to: 1, dataCategories: 2, purpose: 3, crossBorder: 4, destination: 5, safeguards: 6 }, "FR flows mapping");
  const model = toCanonicalModel(r, rows);
  eq(model.flows[0].from, "A", "from normalizes");
  eq(model.flows[0].crossBorder, "Oui", "cross-border value carried");
});

/* ------------------------------------------------------------------ */
/* header row depth                                                     */
/* ------------------------------------------------------------------ */

t("a header buried five rows deep is still found", () => {
  const rows = [
    ["instructions line 1"],
    ["instructions line 2"],
    [""],
    ["more notes"],
    ["almost there"],
    ["System / application name", "Type"],
    ["Shopify", "System"],
  ];
  const r = mapColumns({ name: "Systems", rows });
  eq(r.kind, "template-systems", "kind detected");
  eq(r.headerRow, 5, "headerRow is 5");
  const model = toCanonicalModel(r, rows);
  eq(model.systems.length, 1, "data row after the deep header normalizes");
  eq(model.systems[0].name, "Shopify", "name intact");
});

t("findHeaderRow picks the best-scoring row, not just the first", () => {
  const rows = [
    ["Type", "Notes"],
    ["System / application name", "Type", "Data categories"],
  ];
  eq(findHeaderRow(rows), 1, "row 1 outscores row 0");
});

/* ------------------------------------------------------------------ */
/* section splitting extensions                                         */
/* ------------------------------------------------------------------ */

t("repeated SYSTEMS markers get numbered suffixes", () => {
  const rows = [
    ["SYSTEMS"],
    ["System / application name", "Type"],
    ["A", "System"],
    ["SYSTEMS"],
    ["System / application name", "Type"],
    ["B", "System"],
  ];
  const parts = splitSections({ name: "S", rows });
  eq(parts.length, 2, "two sections");
  eq(parts[0].name, "S (Systems)", "first keeps the plain suffix");
  eq(parts[1].name, "S (Systems) 2", "second gets a number");
  eq(mapColumns(parts[1]).kind, "template-systems", "second section maps");
});

t("FR section markers split too", () => {
  const rows = [
    ["SYSTEMES"],
    ["Nom du systeme", "Type"],
    ["A", "Systeme"],
    ["FLUX DE DONNEES"],
    ["De", "Vers"],
    ["A", "B"],
  ];
  const parts = splitSections({ name: "F", rows });
  eq(parts.length, 2, "two sections");
  eq(mapColumns(parts[0]).kind, "template-systems", "FR systems section maps");
  eq(mapColumns(parts[1]).kind, "template-flows", "FR flows section maps");
});

t("a marker-looking row with data in other cells is not a marker", () => {
  const rows = [
    ["System / application name", "Type"],
    ["SYSTEMS", "not really a marker"],
  ];
  const parts = splitSections({ name: "S", rows });
  eq(parts.length, 1, "no split");
});

/* ------------------------------------------------------------------ */
/* exporter fast path without the sheet-name signal                     */
/* ------------------------------------------------------------------ */

t("exact exporter headers detect by signature even with a plain sheet name", () => {
  const r = mapColumns({ name: "My data", rows: [["Label", "Type"], ["A", "System"]] });
  eq(r.kind, "exporter-nodes", "header signature alone detects exporter-nodes");
  eq(r.confidence, 1.0, "confidence 1.0");
  const c = mapColumns({ name: "Links", rows: [["From", "To", "Category"], ["A", "B", "Payment"]] });
  eq(c.kind, "exporter-connections", "header signature alone detects exporter-connections");
});

t("a Nodes sheet whose headers do not match the signature is not the fast path", () => {
  const r = mapColumns({ name: "Nodes", rows: [["Label", "Owner"], ["A", "Ops"]] });
  ok(r.kind !== "exporter-nodes" || r.confidence < 1.0, "no confident fast path");
});

/* ------------------------------------------------------------------ */
/* normalizeHeader                                                      */
/* ------------------------------------------------------------------ */

t("normalizeHeader strips parentheticals, accents, and the oe ligature", () => {
  eq(normalizeHeader("From (system)"), "from", "parenthetical stripped");
  eq(normalizeHeader("  Cross-Border?  "), "cross-border?", "trimmed and lowercased");
  eq(normalizeHeader("Données transférées"), "donnees transferees", "accents stripped");
  eq(normalizeHeader("Nœuds"), "noeuds", "ligature expanded");
  eq(normalizeHeader(null), "", "null safe");
  eq(normalizeHeader("Étiquette"), "etiquette", "FR label header normalized");
});

/* ------------------------------------------------------------------ */

if (failures.length) {
  for (const f of failures) console.error("FAIL " + f);
  console.error("FAILED " + failures.length + " test(s), " + passed + " assertion(s) passed before failure");
  process.exitCode = 1;
} else {
  console.log("PASS " + passed);
}
