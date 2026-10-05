/*
 * review-cards.test.js - regression test for the 2026-10-05 review-screen
 * placeholder leak.
 *
 * Root cause: narrate.js fill() returned the raw {placeholder} when a
 * variable was missing, and reviewPrompt() did a NESTED fill (the inner
 * "{cat} flow from {a_label} to {b_label}" template embedded into
 * "I drew this as {category}. Right?"). With an incomplete context the
 * inner fill returned the template verbatim and the reader saw
 * "I drew this as {cat} flow from {a_label} to {b_label}. Right?".
 *
 * The interrogation templates are gone; reviewCardText() builds card
 * strings by concatenation from resolved values, so an unfilled
 * placeholder is impossible by construction. This test asserts the
 * guarantee: for every row kind (node / edge / retention), in EN and FR,
 * including adversarial contexts (missing labels, missing cat, missing
 * type, empty object), no {placeholder} survives in any rendered string.
 * It also pins the fail-closed fill() behavior on the exact leaked
 * template from the bug report.
 *
 * Run: node review-cards.test.js   (from tests/tokenizer-executor/)
 */
"use strict";

global.self = global; /* BEFORE requiring UMD modules */

var assert = require("assert");
var path = require("path");
function mod(name) {
  return require(path.join(__dirname, "..", "..", "web", "executor", "js", name));
}

var N = mod("narrate.js"); global.S1Narrate = N;

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

/* The interrogation API is gone; the card renderer is the replacement. */
check(typeof N.reviewPrompt === "undefined",
  "reviewPrompt (interrogation pattern) is removed");
check(typeof N.reviewCardText === "function",
  "reviewCardText is exported");

/* Every row kind x every language x adversarial contexts. */
var contexts = {
  node: [
    { label: "CRM", type: "collection" },
    { label: "CRM", type: "system" },
    { label: "CRM", type: "thirdparty" },
    { label: "CRM", type: "destruction" },
    { label: "CRM" },              /* missing type */
    { type: "system" },            /* missing label */
    { label: "CRM", type: "bogus" }, /* unknown type */
    {}                            /* empty */
  ],
  edge: [
    { aLabel: "Web form", bLabel: "CRM", cat: "contact" },
    { aLabel: "Web form", bLabel: "CRM", cat: "payment" },
    { aLabel: "Web form", bLabel: "CRM", cat: "marketing" },
    { aLabel: "Web form", bLabel: "CRM" }, /* missing cat */
    { cat: "contact" },                    /* missing labels */
    { aLabel: "A", bLabel: "B", cat: "bogus" }, /* unknown cat */
    {}                                     /* empty */
  ],
  retention: [
    { label: "CRM", min: 2, max: 7 },
    { label: "CRM", verify: true },
    { label: "CRM" },  /* no range at all */
    {}                 /* empty */
  ]
};

["en", "fr"].forEach(function (lang) {
  Object.keys(contexts).forEach(function (kind) {
    contexts[kind].forEach(function (ctx, ci) {
      var card;
      try {
        card = N.reviewCardText(kind, ctx, lang);
      } catch (e) {
        check(false, "reviewCardText " + kind + "/" + lang + " ctx#" + ci +
          " threw: " + e.message);
        return;
      }
      ["group", "name", "typeLine"].forEach(function (field) {
        check(typeof card[field] === "string" && card[field].length > 0,
          "reviewCardText " + kind + "/" + lang + " ctx#" + ci +
          " renders a non-empty " + field);
        check(!LEFTOVER.test(card[field]),
          "reviewCardText " + kind + "/" + lang + " ctx#" + ci +
          " " + field + " has no unfilled placeholder");
      });
      check(typeof card.groupKey === "string" && card.groupKey.length > 0,
        "reviewCardText " + kind + "/" + lang + " ctx#" + ci +
        " carries a stable groupKey");
    });
  });
});

/* The four demanded group headings render verbatim. */
var groups = {};
["en", "fr"].forEach(function (lang) {
  groups[lang] = [
    N.reviewCardText("node", { label: "X", type: "collection" }, lang).group,
    N.reviewCardText("node", { label: "X", type: "system" }, lang).group,
    N.reviewCardText("node", { label: "X", type: "thirdparty" }, lang).group,
    N.reviewCardText("edge", { aLabel: "A", bLabel: "B", cat: "contact" }, lang).group
  ];
});
check(groups.en[0] === "Collection points", "EN group: Collection points");
check(groups.en[1] === "Systems", "EN group: Systems");
check(groups.en[2] === "Third parties", "EN group: Third parties");
check(groups.en[3] === "Data flows", "EN group: Data flows");
check(groups.fr[0] === "Points de collecte", "FR group: Points de collecte");
check(groups.fr[1] === "Systèmes", "FR group: Systèmes");
check(groups.fr[2] === "Tiers", "FR group: Tiers");
check(groups.fr[3] === "Flux de données", "FR group: Flux de données");

/* Spot checks on card wording. */
var c = N.reviewCardText("edge",
  { aLabel: "Web form", bLabel: "CRM", cat: "payment" }, "en");
check(c.name === "Web form → CRM", "EN edge card name joins the labels");
check(c.typeLine === "Data flow · Payment", "EN edge card type line");
var cf = N.reviewCardText("edge",
  { aLabel: "Formulaire", bLabel: "CRM", cat: "payment" }, "fr");
check(cf.typeLine === "Flux de données · Paiement", "FR edge card type line");
var r = N.reviewCardText("retention", { label: "CRM", min: 6, max: 7 }, "fr");
check(r.typeLine === "Note de conservation · de 6 à 7 ans",
  "FR retention card range wording");
var rv = N.reviewCardText("retention", { label: "CRM", verify: true }, "en");
check(rv.typeLine === "Retention note · to verify",
  "EN verify-only retention wording");
var un = N.reviewCardText("node", {}, "en");
check(un.name === "Unnamed item", "missing label degrades to a plain fallback, EN");
var unf = N.reviewCardText("node", {}, "fr");
check(unf.name === "Élément sans nom", "missing label degrades to a plain fallback, FR");

/* Fail-closed fill: the exact leaked template from the bug report must
   never render with a raw placeholder, even with an empty context. */
var leaked = "I drew this as {cat} flow from {a_label} to {b_label}. Right?";
var out = N.narrate("connect", {}, null, {});
check(!LEFTOVER.test(out.en) && !LEFTOVER.test(out.fr),
  "narrate() never leaks a raw placeholder (fail-closed fill)");
check(out.en.indexOf("{cat}") === -1 && leaked.indexOf("{cat}") !== -1,
  "the reported leak template cannot reproduce");

/* Hostile input still passes through verbatim (plain-text model). */
var hostile = '<img src=x onerror=alert(1)>';
var hc = N.reviewCardText("node", { label: hostile, type: "system" }, "en");
check(hc.name === hostile, "card name passes hostile text through verbatim");

if (failed > 0) {
  console.error("FAILED: " + failed + " of " + passed);
  process.exitCode = 1;
} else {
  console.log("PASS " + passed);
}
