/*
 * narrate-i18n.test.js - step-log narration templates (EN + Quebec French)
 * and UI chrome strings.
 *
 * Covers: every narrate() template renders without throwing for EN and FR
 * with no unfilled placeholders; reviewPrompt and correctionConfirm in both
 * languages; FR key-set equality vs EN; Quebec French spot checks; no em
 * dashes; XSS safety by construction (templates are plain text: hostile
 * input passes through verbatim, templates introduce no markup).
 *
 * Run: node narrate-i18n.test.js   (from tests/tokenizer-executor/)
 */
"use strict";

global.self = global; /* BEFORE requiring UMD modules */

var assert = require("assert");
var path = require("path");
function mod(name) {
  return require(path.join(__dirname, "..", "..", "web", "executor", "js", name));
}

var N = mod("narrate.js"); global.S1Narrate = N;
var I = mod("i18n.js"); global.S1I18n = I;

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

var LEFTOVER = /\{[a-zA-Z_]+\}/;

/* ---- narrate(): every action, EN + FR ---- */
var cases = [
  ["add_node", { type: "system" }, null, { label: "CRM" }],
  ["add_collection_point", {}, null, { label: "Web form" }],
  ["connect", { cat: "contact" }, null, { a_label: "A", b_label: "B" }],
  ["set_field", { field: "label", value: "X" }, null, { label: "CRM" }],
  ["set_retention", { verify_only: true, record_type: "invoices" }, null, { label: "CRM" }],
  ["set_retention",
    { range_min_years: 2, range_max_years: 7, record_type: "invoices",
      statute: "Tax Act s. 230(4)", anchor: "contract end" },
    null, { label: "CRM" }],
  ["confirm_node", { note: "looks good" }, null, { label: "CRM" }],
  ["confirm_node", {}, null, { label: "CRM" }],
  ["flag_for_review", { reason: "check this" }, null, { target: "n1" }],
  ["run_check", { checks: ["label_coverage", "connectivity"] },
    { report: { label_coverage: { pass: true }, connectivity: { pass: false } } }, {}],
  ["export", {}, null, {}],
  ["skip_recipe_item", { item_index: 3, reason: "not needed" }, null, {}],
  ["undo_last", {}, { undone_action: "add_node" }, { detail: "removed n1" }],
  ["abort_session", { reason: "operator stop" }, null, {}],
  ["frobnicate", {}, null, {}] /* unknown action: default branch */
];
cases.forEach(function (c, i) {
  var out;
  try {
    out = N.narrate(c[0], c[1], c[2], c[3]);
  } catch (e) {
    check(false, "narrate case " + i + " (" + c[0] + ") threw: " + e.message);
    return;
  }
  check(typeof out.en === "string" && out.en.length > 0,
    "narrate " + c[0] + " renders EN");
  check(typeof out.fr === "string" && out.fr.length > 0,
    "narrate " + c[0] + " renders FR");
  check(!LEFTOVER.test(out.en),
    "narrate " + c[0] + " EN has no unfilled placeholder");
  check(!LEFTOVER.test(out.fr),
    "narrate " + c[0] + " FR has no unfilled placeholder");
});
/* missing ctx defaults to {} without throwing */
check(N.narrate("export", {}, null).en.length > 0,
  "narrate tolerates a missing ctx");

/* ---- Quebec French spot checks on narration ---- */
check(N.narrate("add_node", { type: "system" }, null, { label: "CRM" }).fr ===
  "« CRM » ajouté comme système.", "FR add_node wording");
check(N.narrate("skip_recipe_item", { item_index: 3, reason: "r" }, null, {}).fr ===
  "Étape 3 sautée : r.", "FR skip wording");
check(N.narrate("undo_last", {}, { undone_action: "add_node" }, { detail: "d" }).fr ===
  "« add_node » annulé : d.", "FR undo wording");
check(/Vérifications lancées/.test(
  N.narrate("run_check", { checks: ["a"] }, { report: { a: { pass: true } } }, {}).fr),
  "FR run_check wording");
check(N.narrate("export", {}, null, {}).fr === "Inventaire Excel téléchargé.",
  "FR export wording");
check(N.narrate("confirm_node", {}, null, { label: "CRM" }).fr === "« CRM » confirmé.",
  "FR confirm wording");

/* ---- reviewPrompt ---- */
["collection", "system", "thirdparty", "destruction"].forEach(function (t) {
  var en = N.reviewPrompt("node", { label: "CRM", type: t }, "en");
  var fr = N.reviewPrompt("node", { label: "CRM", type: t }, "fr");
  check(en.length > 0 && !LEFTOVER.test(en), "reviewPrompt node/" + t + " EN");
  check(fr.length > 0 && !LEFTOVER.test(fr), "reviewPrompt node/" + t + " FR");
});
var edgeEn = N.reviewPrompt("edge",
  { cat: "contact", a_label: "A", b_label: "B" }, "en");
var edgeFr = N.reviewPrompt("edge",
  { cat: "contact", a_label: "A", b_label: "B" }, "fr");
check(edgeEn === "I drew this as contact flow from A to B. Right?",
  "reviewPrompt edge EN wording");
check(edgeFr === "Ce lien est un flux contact de « A » vers « B ». C'est bien ça ?",
  "reviewPrompt edge FR wording");

/* ---- correctionConfirm ---- */
[
  ["retype", { label: "CRM", type: "system" }],
  ["relabel", { label: "CRM" }],
  ["move", {}],
  ["reconnect", { b_label: "Site" }],
  ["bogus-kind", {}]
].forEach(function (c) {
  var en = N.correctionConfirm(c[0], c[1], "en");
  var fr = N.correctionConfirm(c[0], c[1], "fr");
  check(typeof en === "string" && en.length > 0 && !LEFTOVER.test(en),
    "correctionConfirm " + c[0] + " EN");
  check(typeof fr === "string" && fr.length > 0 && !LEFTOVER.test(fr),
    "correctionConfirm " + c[0] + " FR");
});
check(N.correctionConfirm("relabel", { label: "CRM" }, "fr") ===
  "Corrigé : nommer « CRM ».", "FR relabel wording");

/* ---- i18n key-set equality: FR must not miss keys vs EN ---- */
function keySet(o) { return Object.keys(o).sort(); }
check(JSON.stringify(keySet(I.STRINGS.en)) === JSON.stringify(keySet(I.STRINGS.fr)),
  "FR top-level key set equals EN");
["sectorNames", "regionNames", "typesNames"].forEach(function (k) {
  check(JSON.stringify(keySet(I.STRINGS.en[k])) ===
    JSON.stringify(keySet(I.STRINGS.fr[k])),
    "FR " + k + " key set equals EN");
});
/* every leaf is a non-empty string */
var leafCount = 0;
function walk(o, lang) {
  Object.keys(o).forEach(function (k) {
    var v = o[k];
    if (v !== null && typeof v === "object") { walk(v, lang); return; }
    leafCount++;
    check(typeof v === "string" && v.length > 0,
      lang + "." + k + " is a non-empty string");
    check(v.indexOf("—") === -1, lang + "." + k + " has no em dash");
  });
}
walk(I.STRINGS.en, "en");
walk(I.STRINGS.fr, "fr");
check(leafCount > 150, "scanned " + leafCount + " i18n leaves");

/* ---- Quebec French spot checks on chrome strings ---- */
var fr = I.strings("fr");
check(fr.entryButton === "Commencer", "FR entryButton");
check(fr.back === "Retour", "FR back");
check(fr.stop === "Arrêter", "FR stop");
check(fr.confirm === "Confirmer", "FR confirm");
check(fr.wipe === "Tout effacer", "FR wipe");
check(fr.downloadExcel === "Télécharger le chiffrier brouillon", "FR downloadExcel");
check(fr.reviewDone === "Révision terminée.", "FR reviewDone");
check(fr.chatGreeting.indexOf("Bonjour.") === 0, "FR chatGreeting opens in French");
check(fr.chatGreeting.indexOf("avis juridique") !== -1,
  "FR chatGreeting keeps the not-legal-advice line");
check(fr.trustCopy === "Tout se passe dans votre navigateur. Rien n’est envoyé nulle part.",
  "FR trustCopy wording");

/* ---- strings() selection ---- */
check(I.strings("fr") === I.STRINGS.fr, "strings('fr') returns FR");
check(I.strings("en") === I.STRINGS.en, "strings('en') returns EN");
check(I.strings("de") === I.STRINGS.en, "unknown locale falls back to EN");
check(I.strings().chatTicket.indexOf("{id}") !== -1,
  "chatTicket keeps its placeholders for fill");

/* ---- XSS safety by construction ---- */
var hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
cases.forEach(function (c) {
  var ctx = {};
  Object.keys(c[3] || {}).forEach(function (k) { ctx[k] = hostile; });
  var out = N.narrate(c[0], c[1], c[2], ctx);
  ["en", "fr"].forEach(function (lang) {
    var hasHostileLabel = ["label", "a_label", "b_label", "target"].some(function (k) {
      return (c[3] || {})[k] !== undefined;
    });
    if (hasHostileLabel) {
      check(out[lang].indexOf(hostile) !== -1,
        "narrate " + c[0] + " " + lang + " passes hostile text through verbatim (plain-text model)");
    }
  });
});
/* templates themselves introduce no markup: empty vars -> no angle brackets */
cases.forEach(function (c) {
  var out = N.narrate(c[0], c[1], c[2], {});
  check(out.en.indexOf("<") === -1 && out.en.indexOf(">") === -1,
    "narrate " + c[0] + " EN template introduces no markup");
  check(out.fr.indexOf("<") === -1 && out.fr.indexOf(">") === -1,
    "narrate " + c[0] + " FR template introduces no markup");
});

if (failed > 0) {
  console.error("FAILED: " + failed + " of " + passed);
  process.exitCode = 1;
} else {
  console.log("PASS " + passed);
}
