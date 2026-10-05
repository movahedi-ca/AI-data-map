/**
 * templates.js - 4-chip intake and deterministic template selection.
 *
 * Per the executor domain contract (section 7): four chips (size band,
 * sector, region, data types) select a recipe from a fixed template table,
 * TABLE[size][sector][region][types]. Selection is a pure lookup, zero
 * runtime tokens. The chatbot builds the recipe and never executes.
 *
 * Scope note (contract Q8): the full 384-template authoring is Phase 7
 * work against vendor-kb.json. This file ships 3 representative template
 * skeletons covering the Amelie story plus two variants; any other chip
 * vector resolves to null with the nearest authored templates listed, and
 * the UI says plainly that the combination is not authored yet.
 *
 * The vendor names in these skeletons are representative placeholders for
 * the Phase 7 KB-grounded authoring; the retention citations follow the
 * retention rule (ranges only, statute cited or verify_only flag).
 *
 * UMD: runs in browsers and Node. No network, no storage, no em dashes.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module !== null && typeof module.exports === "object") {
    module.exports = api;
  } else {
    root.S1Templates = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* The four chips and their fixed option lists (domain contract 7.1). */
  var CHIPS = [
    {
      id: "size",
      options: ["1-10", "11-50", "51-200", "200+"]
    },
    {
      id: "sector",
      options: ["retail", "services", "health", "tech", "manufacturing", "nonprofit"]
    },
    {
      id: "region",
      options: ["quebec", "canada", "canada-us", "international"]
    },
    {
      id: "types",
      options: ["contact", "contact-payment", "contact-marketing", "all"]
    }
  ];

  var TAX_STATUTE = "Loi sur l'administration fiscale, RLRQ, c. A-6.002, ss. 34, 35.3";
  var AS_OF = "2026-10-04";
  var ALL_CHECKS = ["label_coverage", "connectivity", "retention_cited", "edge_categories"];

  function item(intent, params) {
    return { intent: intent, params: params };
  }

  function tail(checks) {
    return [
      item("run_check", { checks: checks || ALL_CHECKS.slice() }),
      item("export", { format: "xls" })
    ];
  }

  /* Template 1: the Amelie story. 11-50, services, Quebec, all data types. */
  var T_AMELIE = {
    recipe_id: "t-2-services-qc-all-01",
    schema_version: "1.0.0",
    name: "Services firm, Quebec, contact plus payments plus marketing",
    chips: { size: "11-50", sector: "services", region: "quebec", types: "all" },
    items: [
      item("add_collection_point", { node_id: "n1", x: 80, y: 80, label: "Client intake form" }),
      item("add_node", { node_id: "n2", type: "system", x: 310, y: 80, label: "Microsoft 365" }),
      item("add_node", { node_id: "n3", type: "thirdparty", x: 545, y: 80, label: "Stripe" }),
      item("add_node", { node_id: "n4", type: "thirdparty", x: 545, y: 240, label: "Mailchimp" }),
      item("connect", { a: "n1", b: "n2", cat: "contact" }),
      item("connect", { a: "n2", b: "n3", cat: "payment" }),
      item("connect", { a: "n2", b: "n4", cat: "marketing" }),
      item("set_retention", {
        node_id: "n2", record_type: "Quebec tax books and records",
        range_min_years: 6, range_max_years: 7, statute: TAX_STATUTE, as_of: AS_OF
      }),
      item("set_retention", {
        node_id: "n3", record_type: "Payment transaction records",
        verify_only: true, as_of: AS_OF
      }),
      item("set_retention", {
        node_id: "n4", record_type: "Marketing consent records",
        verify_only: true, as_of: AS_OF
      })
    ].concat(tail())
  };

  /* Template 2: small retailer, Quebec, contact plus payments. */
  var T_RETAIL = {
    recipe_id: "t-1-retail-qc-contact-payment-01",
    schema_version: "1.0.0",
    name: "Small retailer, Quebec, contact plus payments",
    chips: { size: "1-10", sector: "retail", region: "quebec", types: "contact-payment" },
    items: [
      item("add_collection_point", { node_id: "n1", x: 80, y: 80, label: "Online checkout form" }),
      item("add_node", { node_id: "n2", type: "system", x: 310, y: 80, label: "Shopify" }),
      item("add_node", { node_id: "n3", type: "thirdparty", x: 545, y: 80, label: "Stripe" }),
      item("connect", { a: "n1", b: "n2", cat: "contact" }),
      item("connect", { a: "n2", b: "n3", cat: "payment" }),
      item("set_retention", {
        node_id: "n2", record_type: "Quebec tax books and records",
        range_min_years: 6, range_max_years: 7, statute: TAX_STATUTE, as_of: AS_OF
      }),
      item("set_retention", {
        node_id: "n3", record_type: "Payment transaction records",
        verify_only: true, as_of: AS_OF
      })
    ].concat(tail())
  };

  /* Template 3: mid-size tech firm, Canada and the US, contact plus marketing.
     The canada-us chip adds the cross-border review flag (domain contract 7.2):
     the run pauses when the flag opens and the review pass clears it. */
  var T_TECH = {
    recipe_id: "t-3-tech-caus-contact-marketing-01",
    schema_version: "1.0.0",
    name: "Tech firm, Canada and the US, contact plus marketing",
    chips: { size: "51-200", sector: "tech", region: "canada-us", types: "contact-marketing" },
    items: [
      item("add_collection_point", { node_id: "n1", x: 80, y: 80, label: "Signup form" }),
      item("add_node", { node_id: "n2", type: "system", x: 310, y: 80, label: "HubSpot" }),
      item("add_node", { node_id: "n3", type: "thirdparty", x: 545, y: 80, label: "Mailchimp" }),
      item("connect", { a: "n1", b: "n2", cat: "contact" }),
      item("connect", { a: "n2", b: "n3", cat: "marketing" }),
      item("set_retention", {
        node_id: "n2", record_type: "Customer account records",
        verify_only: true, as_of: AS_OF
      }),
      item("set_retention", {
        node_id: "n3", record_type: "Marketing consent records",
        verify_only: true, as_of: AS_OF
      }),
      item("flag_for_review", {
        node_id: "n3",
        reason: "Cross-border transfer to the United States: confirm the safeguards before finalizing."
      })
    ].concat(tail())
  };

  var AUTHORED = [T_AMELIE, T_RETAIL, T_TECH];

  /* Chip metadata lives outside the recipe object: the recipe schema
     (additionalProperties: false) allows only recipe_id, schema_version,
     name, and items. */
  var META = {};
  AUTHORED.forEach(function (t) {
    META[t.recipe_id] = { chips: t.chips, name: t.name, items: t.items.length };
    delete t.chips;
  });

  function chipKey(chips) {
    return [chips.size, chips.sector, chips.region, chips.types].join("|");
  }

  var TABLE = {};
  AUTHORED.forEach(function (t) { TABLE[chipKey(META[t.recipe_id].chips)] = t; });

  /**
   * Pure lookup: chip vector -> template skeleton (deep copy), or null when
   * the combination is not authored yet (Phase 7). The returned object
   * contains only recipe-schema fields.
   */
  function selectTemplate(chips) {
    var t = TABLE[chipKey(chips)];
    if (!t) return null;
    return JSON.parse(JSON.stringify(t));
  }

  function authoredTemplates() {
    return AUTHORED.map(function (t) {
      var m = META[t.recipe_id];
      return { recipe_id: t.recipe_id, name: m.name, chips: m.chips, items: m.items };
    });
  }

  function validateChips(chips) {
    var problems = [];
    CHIPS.forEach(function (chip) {
      var v = chips[chip.id];
      if (chip.options.indexOf(v) === -1) {
        problems.push(chip.id + " must be one of " + chip.options.join(", "));
      }
    });
    return problems;
  }

  return {
    CHIPS: CHIPS,
    selectTemplate: selectTemplate,
    authoredTemplates: authoredTemplates,
    validateChips: validateChips,
    TAX_STATUTE: TAX_STATUTE,
    AS_OF: AS_OF
  };
});
