/**
 * dangling.test.js - dangling flow references.
 *
 * Flows that name systems missing from the Systems sheet must be reported as
 * DANGLING_REF with the referencing row identified, and must never produce
 * edges in the built state.
 *
 * Run: node dangling.test.js   (from this directory)
 * No DOM, no network.
 */
"use strict";

global.self = global;
const assert = require("assert");

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
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const SYSTEMS_HEADERS = [
  "System / application name", "Type", "Data categories", "Purposes of use",
  "Lawful basis", "Retention period", "Storage location", "Owner / department", "Notes",
];
const FLOWS_HEADERS = [
  "From (system)", "To (system)", "Data categories transferred", "Purpose of transfer",
  "Cross-border?", "Destination", "Safeguards", "Notes",
];

function modelOf(systemsData, flowsData) {
  const sm = mapColumns({ name: "Systems", rows: [SYSTEMS_HEADERS, ...systemsData] });
  const fm = mapColumns({ name: "Data flows", rows: [FLOWS_HEADERS, ...flowsData] });
  const sa = toCanonicalModel(sm, [SYSTEMS_HEADERS, ...systemsData]);
  const fa = toCanonicalModel(fm, [FLOWS_HEADERS, ...flowsData]);
  return { systems: sa.systems, flows: fa.flows, rejected: [...sa.rejected, ...fa.rejected] };
}

function sys(name, type) {
  return [name, type || "System", "data", "use", "Consent", "7 years", "Canada", "Ops", ""];
}
function flow(from, to) {
  return [from, to, "data", "sync", "No", "", "", ""];
}

/* ------------------------------------------------------------------ */
/* validate(): DANGLING_REF reports                                     */
/* ------------------------------------------------------------------ */

t("a flow to a missing system raises DANGLING_REF identifying the row", () => {
  const model = modelOf(
    [sys("Shopify"), sys("Klaviyo")],
    [flow("Shopify", "Klaviyo"), flow("Shopify", "Ghost Vendor")]
  );
  const flags = validate(model).filter((f) => f.code === "DANGLING_REF");
  eq(flags.length, 1, "exactly one dangling flag");
  const f = flags[0];
  eq(f.severity, "error", "dangling is an error");
  eq(f.row, 3, "flag names the referencing 1-based row");
  ok(f.message.includes("Ghost Vendor"), "message names the missing system");
  ok(/\bto\b/i.test(f.message) && /'Ghost Vendor'/.test(f.message), "message says it is the To endpoint");
  deq(Object.keys(f).sort(), ["code", "message", "row", "severity"], "flag shape is the contract");
  ok(!/\u2014/.test(f.message), "no em dash in the message");
});

t("a flow from a missing system is reported too", () => {
  const model = modelOf([sys("Shopify")], [flow("Phantom CRM", "Shopify")]);
  const flags = validate(model).filter((f) => f.code === "DANGLING_REF");
  eq(flags.length, 1, "one dangling flag");
  ok(/from/i.test(flags[0].message), "message says it is the From endpoint");
  ok(flags[0].message.includes("Phantom CRM"), "message names the missing system");
  eq(flags[0].row, 2, "row 2 identified");
});

t("both endpoints missing raises two flags on the same row", () => {
  const model = modelOf([sys("Shopify")], [flow("Ghost A", "Ghost B")]);
  const flags = validate(model).filter((f) => f.code === "DANGLING_REF");
  eq(flags.length, 2, "two flags");
  deq(flags.map((f) => f.row), [2, 2], "both point at row 2");
  ok(flags.some((f) => /from/i.test(f.message)), "one is the From endpoint");
  ok(flags.some((f) => /\bto\b/i.test(f.message)), "one is the To endpoint");
});

t("matching is case- and punctuation-insensitive, but exact on the normalized name", () => {
  const model = modelOf(
    [sys("Shopify"), sys("Klaviyo Inc.")],
    [flow("SHOPIFY", "Klaviyo Inc"), flow("shopify ", "Klaviyo")]
  );
  const flags = validate(model).filter((f) => f.code === "DANGLING_REF");
  eq(flags.length, 1, "only the suffix-dropped endpoint dangles");
  ok(flags[0].message.includes("'Klaviyo'"), "dangling names the short form");
  eq(flags[0].row, 3, "row 3 identified");
  // Case/whitespace/punctuation variants of an EXACT normalized name resolve.
  const clean = modelOf([sys("O'Brien & Sons, Ltd.")], [flow("obrien  sons ltd", "O'BRIEN & SONS, LTD.")]);
  deq(validate(clean).filter((f) => f.code === "DANGLING_REF"), [], "punctuation variants resolve");
});

t("empty systems list makes every flow dangle, each row identified", () => {
  const model = modelOf([], [flow("A", "B"), flow("C", "D")]);
  const flags = validate(model).filter((f) => f.code === "DANGLING_REF");
  eq(flags.length, 4, "two flags per flow");
  deq(flags.map((f) => f.row), [2, 2, 3, 3], "rows 2 and 3 identified");
  ok(flags.every((f) => f.severity === "error"), "all errors");
});

t("dangling coexists with other flags without interference", () => {
  const model = modelOf(
    [sys("Shopify"), sys("shopify ")],
    [flow("Shopify", "Nowhere Ltd")]
  );
  const byCode = {};
  for (const f of validate(model)) (byCode[f.code] = byCode[f.code] || []).push(f);
  eq(byCode.DANGLING_REF.length, 1, "dangling reported");
  eq(byCode.LIKELY_DUPLICATE.length, 1, "duplicate still reported");
  ok(!byCode.DANGLING_REF[0].message.includes("shopify"), "dangling message is about the missing system only");
});

/* ------------------------------------------------------------------ */
/* state-builder: dangling flows never become edges                     */
/* ------------------------------------------------------------------ */

t("buildState excludes dangling flows and lists them in rejected", () => {
  const model = modelOf(
    [sys("Checkout form", "Collection point"), sys("Shopify"), sys("Klaviyo", "Third party")],
    [flow("Checkout form", "Shopify"), flow("Shopify", "Klaviyo"), flow("Shopify", "Nowhere Ltd"), flow("Ghost", "Klaviyo")]
  );
  const confirmed = { categories: { 0: "payment", 1: "marketing", 2: "contact", 3: "contact" } };
  const state = buildState(model, confirmed);
  eq(state.edges.length, 2, "only the two resolvable flows become edges");
  eq(state.rejected.length, 2, "two rejections");
  ok(state.rejected.every((r) => r.kind === "flow"), "rejections are flow-kind");
  deq(state.rejected.map((r) => r.row), [4, 5], "rejections name rows 4 and 5");
  const reasons = state.rejected.map((r) => r.reason).join(" | ");
  ok(reasons.includes("Nowhere Ltd"), "missing To named in the rejection");
  ok(reasons.includes("Ghost"), "missing From named in the rejection");
  ok(state.rejected.every((r) => r.flow && r.flow.from && r.flow.to), "rejections carry the from/to pair");
  deq(state.rejected[0].flow, { from: "Shopify", to: "Nowhere Ltd" }, "first rejected flow pair exact");
});

t("fixing the spelling clears both the flag and the rejection", () => {
  const bad = modelOf([sys("Shopify")], [flow("Shopify", "Klaviyo")]);
  eq(validate(bad).filter((f) => f.code === "DANGLING_REF").length, 1, "dangles before the fix");
  const fixed = modelOf([sys("Shopify"), sys("Klaviyo", "Third party")], [flow("Shopify", "Klaviyo")]);
  const flags = validate(fixed).filter((f) => f.code === "DANGLING_REF");
  deq(flags, [], "no dangling flags after adding the system");
  const state = buildState(fixed, { categories: { 0: "marketing" } });
  eq(state.edges.length, 1, "edge drawn after the fix");
  deq(state.rejected, [], "nothing rejected after the fix");
});

t("a dangling flow never leaks a half-built edge into state", () => {
  const model = modelOf([sys("Shopify")], [flow("Shopify", "Klaviyo")]);
  const state = buildState(model, { categories: { 0: "marketing" } });
  deq(state.edges, [], "no edges at all");
  eq(state.seq, 1, "the one known system is still placed");
  deq(Object.keys(state.nodes), ["n1"], "single node");
  eq(state.nodes.n1.label, "Shopify", "node label intact");
});

/* ------------------------------------------------------------------ */

if (failures.length) {
  for (const f of failures) console.error("FAIL " + f);
  console.error("FAILED " + failures.length + " test(s), " + passed + " assertion(s) passed before failure");
  process.exitCode = 1;
} else {
  console.log("PASS " + passed);
}
