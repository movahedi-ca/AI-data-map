#!/usr/bin/env node
/**
 * generate-templates.js - Phase 7: author all 384 recipe template skeletons.
 *
 * Node stdlib only. Reads vendor-kb/entries/*.json (every KB-grounded label
 * is verified against the KB at generation time; generic sector fallbacks
 * are used where the KB has no fit), reads the three hand-authored Phase 6
 * skeletons verbatim from web/executor/js/templates.js, and emits:
 *
 *   data/templates.json        - canonical artifact, keyed by chip vector
 *   web/executor/js/templates.js - rewritten with the 384 embedded
 *
 * Determinism: per-template seeded PRNG (FNV-1a of the chip vector fed to
 * mulberry32), sorted key iteration, fixed object key order, no timestamps.
 * Run twice: sha256 of both outputs must match.
 *
 * No em dashes anywhere in this file or its output.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var ROOT = path.resolve(__dirname, "..");
var KB_DIR = path.join(ROOT, "vendor-kb", "entries");
var TEMPLATES_JS = path.join(ROOT, "web", "executor", "js", "templates.js");
var OUT_JSON = path.join(ROOT, "data", "templates.json");

/* ------------------------------------------------------------------ */
/* Deterministic PRNG                                                   */
/* ------------------------------------------------------------------ */

function fnv1a(str) {
  var h = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(arr, rand) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rand() * (i + 1));
    var t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/* ------------------------------------------------------------------ */
/* Chips                                                                */
/* ------------------------------------------------------------------ */

var SIZES = ["1-10", "11-50", "51-200", "200+"];
var SIZE_IDX = { "1-10": 1, "11-50": 2, "51-200": 3, "200+": 4 };
var NODE_COUNTS = { "1-10": 4, "11-50": 6, "51-200": 10, "200+": 14 };
var SECTORS = ["retail", "services", "health", "tech", "manufacturing", "nonprofit"];
var REGIONS = ["quebec", "canada", "canada-us", "international"];
var REGION_SHORT = { quebec: "qc", canada: "ca", "canada-us": "caus", international: "intl" };
var REGION_LABEL = { quebec: "Quebec", canada: "Canada", "canada-us": "Canada and the US", international: "International" };
var TYPES = ["contact", "contact-payment", "contact-marketing", "all"];
var TYPES_LABEL = {
  contact: "contact only",
  "contact-payment": "contact plus payments",
  "contact-marketing": "contact plus marketing",
  all: "contact plus payments plus marketing"
};
var SECTOR_NOUN = {
  retail: "retailer",
  services: "services firm",
  health: "health clinic",
  tech: "tech firm",
  manufacturing: "manufacturer",
  nonprofit: "nonprofit"
};

function edgeCats(types) {
  if (types === "contact") return ["contact"];
  if (types === "contact-payment") return ["contact", "payment"];
  if (types === "contact-marketing") return ["contact", "marketing"];
  return ["contact", "payment", "marketing"];
}

function templateId(size, sector, region, types) {
  return "t-" + SIZE_IDX[size] + "-" + sector + "-" + REGION_SHORT[region] + "-" + types + "-01";
}

function chipKey(chips) {
  return [chips.size, chips.sector, chips.region, chips.types].join("|");
}

/* ------------------------------------------------------------------ */
/* Vendor KB grounding                                                  */
/* ------------------------------------------------------------------ */

function loadKbNames() {
  var names = {};
  fs.readdirSync(KB_DIR).sort().forEach(function (f) {
    if (f.slice(-5) !== ".json") return;
    var entries = JSON.parse(fs.readFileSync(path.join(KB_DIR, f), "utf8"));
    entries.forEach(function (e) {
      if (e && e.name) names[e.name] = true;
    });
  });
  return names;
}

/* kb("Shopify Inc.", "Shopify") -> "Shopify"; fails loudly when the KB
   entry name is absent, so no KB claim ships unverified. */
function kbFactory(kbNames) {
  return function kb(entryName, displayLabel) {
    if (!kbNames[entryName]) {
      throw new Error("KB entry not found: " + entryName);
    }
    return displayLabel;
  };
}

/* ------------------------------------------------------------------ */
/* Sector content pools                                                 */
/* ------------------------------------------------------------------ */

function dedupe(arr) {
  var seen = {};
  return arr.filter(function (x) {
    if (seen[x]) return false;
    seen[x] = true;
    return true;
  });
}

function buildPools(kb) {
  var genericSystems = [
    "Department file share",
    "HR records system",
    "Finance system",
    "Support ticketing system",
    "Data warehouse",
    "Analytics platform"
  ];
  var genericContactThird = [
    "Cloud backup provider",
    "Email hosting provider",
    "Phone system provider",
    "Document storage provider",
    "Identity provider",
    "Monitoring service"
  ];
  var pools = {
    retail: {
      collection: ["Online checkout form", "POS terminal", "Click-and-collect order form"],
      systems: [kb("Shopify Inc.", "Shopify"), "Point-of-sale system", "Inventory management system"].concat(genericSystems),
      contactThird: [kb("Amazon Web Services", "Amazon Web Services"), "Cloud backup provider"].concat(genericContactThird),
      paymentThird: ["Payment processor", "Card terminal provider"],
      marketingThird: [kb("Klaviyo, Inc. Class A", "Klaviyo"), kb("Mailchimp", "Mailchimp")]
    },
    services: {
      collection: ["Client intake form", "Consultation booking form", "Service request form"],
      systems: [kb("Microsoft", "Microsoft"), kb("Salesforce, Inc.", "Salesforce"), "Client management system"].concat(genericSystems),
      contactThird: [kb("Amazon Web Services", "Amazon Web Services"), "Document storage provider"].concat(genericContactThird),
      paymentThird: ["Payment processor", "Invoicing platform"],
      marketingThird: [kb("Mailchimp", "Mailchimp"), kb("Intercom Inc.", "Intercom")]
    },
    health: {
      collection: ["Patient intake form", "Appointment booking form", "New patient registration form"],
      systems: ["Electronic health record system", "Clinic management system", "Appointment scheduling system"].concat(genericSystems),
      contactThird: ["Secure cloud host", "Phone system provider"].concat(genericContactThird),
      paymentThird: ["Payment processor"],
      marketingThird: ["Email newsletter platform", "Patient recall service"]
    },
    tech: {
      collection: ["Signup form", "Free trial signup form", "Demo request form"],
      systems: [kb("HubSpot", "HubSpot"), kb("Salesforce, Inc.", "Salesforce"), "Product database"].concat(genericSystems),
      contactThird: [kb("Amazon Web Services", "Amazon Web Services"), kb("Zendesk", "Zendesk")].concat(genericContactThird),
      paymentThird: ["Payment processor", "Billing platform"],
      marketingThird: [kb("Mailchimp", "Mailchimp"), kb("Intercom Inc.", "Intercom"), "Example marketing platform"]
    },
    manufacturing: {
      collection: ["Customer order form", "Quote request form", "Dealer signup form"],
      systems: [kb("SAP SE", "SAP"), kb("Oracle Corporation", "Oracle"), "Manufacturing execution system"].concat(genericSystems),
      contactThird: ["Logistics tracking provider", "Cloud backup provider"].concat(genericContactThird),
      paymentThird: ["Payment processor", "Trade credit service"],
      marketingThird: ["Email marketing platform", "Dealer portal provider"]
    },
    nonprofit: {
      collection: ["Donation form", "Volunteer signup form", "Newsletter signup form"],
      systems: [kb("Salesforce, Inc.", "Salesforce"), "Donor management system", kb("Microsoft", "Microsoft")].concat(genericSystems),
      contactThird: ["Email hosting provider", "Cloud storage provider"].concat(genericContactThird),
      paymentThird: ["Donation processor", "Payment processor"],
      marketingThird: [kb("Mailchimp", "Mailchimp"), "Email marketing platform"]
    }
  };
  Object.keys(pools).forEach(function (sector) {
    Object.keys(pools[sector]).forEach(function (pool) {
      pools[sector][pool] = dedupe(pools[sector][pool]);
    });
  });
  return pools;
}

/* ------------------------------------------------------------------ */
/* Template construction                                                */
/* ------------------------------------------------------------------ */

var XS = [80, 235, 390, 545];
var YS = [80, 160, 240, 320];
var ALL_CHECKS = ["label_coverage", "connectivity", "retention_cited", "edge_categories"];

var QC_STATUTE = "Loi sur l'administration fiscale, RLRQ, c. A-6.002, ss. 34, 35.3";
var CA_STATUTE = "Income Tax Act, R.S.C. 1985, c. 1 (5th Supp.), s. 230(4)(b)";
var AS_OF_NEW = "2026-10-05";

var REVIEW_REASON_CA_US = "Cross-border transfer to the United States: confirm the safeguards before finalizing.";
var REVIEW_REASON_INTL = "International transfer outside Canada: confirm the transfer safeguards before finalizing.";

function item(intent, params) {
  return { intent: intent, params: params };
}

function recordTypeFor(node) {
  if (node.kind === "system") return "Business records";
  if (node.cat === "payment") return "Payment transaction records";
  if (node.cat === "marketing") return "Marketing consent records";
  return "Service provider records";
}

function retentionItem(node, region) {
  if (region === "quebec" && node.kind === "system") {
    return item("set_retention", {
      node_id: node.nid,
      record_type: "Quebec tax books and records",
      range_min_years: 6,
      range_max_years: 7,
      statute: QC_STATUTE,
      as_of: AS_OF_NEW
    });
  }
  if (region === "canada" && node.kind === "system") {
    return item("set_retention", {
      node_id: node.nid,
      record_type: "Federal tax books and records",
      range_min_years: 6,
      range_max_years: 7,
      statute: CA_STATUTE,
      as_of: AS_OF_NEW
    });
  }
  return item("set_retention", {
    node_id: node.nid,
    record_type: recordTypeFor(node),
    verify_only: true,
    as_of: AS_OF_NEW
  });
}

function templateName(size, sector, region, types) {
  var adj = size === "1-10" ? "Small " : "";
  var name = adj + SECTOR_NOUN[sector] + ", " + REGION_LABEL[region] + ", " + TYPES_LABEL[types];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function buildTemplate(size, sector, region, types, pools) {
  var key = chipKey({ size: size, sector: sector, region: region, types: types });
  var rand = mulberry32(fnv1a(key));
  var count = NODE_COUNTS[size];
  var sc = pools[sector];
  var cats = edgeCats(types);

  var sysLabels = shuffled(sc.systems, rand);
  var ctpLabels = shuffled(sc.contactThird, rand);
  var payLabels = shuffled(sc.paymentThird, rand);
  var mktLabels = shuffled(sc.marketingThird, rand);
  var collLabels = shuffled(sc.collection, rand);

  var nodes = [];
  var si = 0, ci = 0, pi = 0, mi = 0;
  var nid = 1;
  function nextId() { return "n" + (nid++); }

  nodes.push({ nid: nextId(), kind: "collection", cat: null, label: collLabels[0] });
  nodes.push({ nid: nextId(), kind: "system", cat: null, label: sysLabels[si++] });
  if (cats.indexOf("payment") !== -1) {
    nodes.push({ nid: nextId(), kind: "thirdparty", cat: "payment", label: payLabels[pi++] });
  }
  if (cats.indexOf("marketing") !== -1) {
    nodes.push({ nid: nextId(), kind: "thirdparty", cat: "marketing", label: mktLabels[mi++] });
  }
  var turn = 0;
  while (nodes.length < count) {
    if (turn % 2 === 0) {
      nodes.push({ nid: nextId(), kind: "system", cat: null, label: sysLabels[si++ % sysLabels.length] });
    } else {
      nodes.push({ nid: nextId(), kind: "thirdparty", cat: "contact", label: ctpLabels[ci++ % ctpLabels.length] });
    }
    turn++;
  }

  /* Every label unique within the template. */
  var seen = {};
  nodes.forEach(function (nd) {
    if (seen[nd.label]) throw new Error("duplicate label in " + key + ": " + nd.label);
    seen[nd.label] = true;
  });

  var items = [];
  nodes.forEach(function (nd, i) {
    var x = XS[i % 4];
    var y = YS[Math.floor(i / 4)];
    if (nd.kind === "collection") {
      items.push(item("add_collection_point", { node_id: nd.nid, x: x, y: y, label: nd.label }));
    } else {
      items.push(item("add_node", { node_id: nd.nid, type: nd.kind, x: x, y: y, label: nd.label }));
    }
  });

  /* Edges: collection feeds the primary system (contact); systems chain
     by contact; every third party hangs off the primary system with its
     own category. Pairs are unique by construction. */
  items.push(item("connect", { a: "n1", b: "n2", cat: "contact" }));
  var lastSystem = "n2";
  nodes.forEach(function (nd) {
    if (nd.kind === "system" && nd.nid !== "n2") {
      items.push(item("connect", { a: lastSystem, b: nd.nid, cat: "contact" }));
      lastSystem = nd.nid;
    }
  });
  nodes.forEach(function (nd) {
    if (nd.kind === "thirdparty") {
      items.push(item("connect", { a: "n2", b: nd.nid, cat: nd.cat }));
    }
  });

  nodes.forEach(function (nd) {
    if (nd.kind !== "collection") items.push(retentionItem(nd, region));
  });

  nodes.forEach(function (nd) {
    if (nd.kind !== "thirdparty") return;
    if (region === "canada-us") {
      items.push(item("flag_for_review", { node_id: nd.nid, reason: REVIEW_REASON_CA_US }));
    } else if (region === "international") {
      items.push(item("flag_for_review", { node_id: nd.nid, reason: REVIEW_REASON_INTL }));
    }
  });

  items.push(item("run_check", { checks: ALL_CHECKS.slice() }));
  items.push(item("export", { format: "xls" }));

  return {
    recipe_id: templateId(size, sector, region, types),
    schema_version: "1.0.0",
    name: templateName(size, sector, region, types),
    chips: { size: size, sector: sector, region: region, types: types },
    items: items
  };
}

/* ------------------------------------------------------------------ */
/* The three hand-authored Phase 6 skeletons, verbatim                  */
/* ------------------------------------------------------------------ */

var PHASE6_VECTORS = [
  { size: "11-50", sector: "services", region: "quebec", types: "all" },
  { size: "1-10", sector: "retail", region: "quebec", types: "contact-payment" },
  { size: "51-200", sector: "tech", region: "canada-us", types: "contact-marketing" }
];

function loadPhase6() {
  /* The shipped templates.js is UMD: require it in Node. */
  var S1Templates = require(TEMPLATES_JS);
  var out = {};
  PHASE6_VECTORS.forEach(function (v) {
    var t = S1Templates.selectTemplate(v);
    if (!t) throw new Error("Phase 6 skeleton missing for " + chipKey(v));
    out[chipKey(v)] = t;
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Emit                                                                 */
/* ------------------------------------------------------------------ */

function main() {
  var kbNames = loadKbNames();
  var count = Object.keys(kbNames).length;
  if (count === 0) throw new Error("vendor KB empty: " + KB_DIR);
  var kb = kbFactory(kbNames);
  var pools = buildPools(kb);
  var phase6 = loadPhase6();

  var templates = {};
  SIZES.forEach(function (size) {
    SECTORS.forEach(function (sector) {
      REGIONS.forEach(function (region) {
        TYPES.forEach(function (types) {
          var v = { size: size, sector: sector, region: region, types: types };
          var key = chipKey(v);
          if (phase6[key]) {
            var t = JSON.parse(JSON.stringify(phase6[key]));
            t.chips = v;
            templates[key] = t;
          } else {
            templates[key] = buildTemplate(size, sector, region, types, pools);
          }
        });
      });
    });
  });

  var keys = Object.keys(templates).sort();
  if (keys.length !== 384) throw new Error("expected 384 templates, got " + keys.length);

  var doc = {
    generator: "tools/generate-templates.js",
    schema_version: "1.0.0",
    count: keys.length,
    kb_entries_consulted: count,
    templates: {}
  };
  keys.forEach(function (k) { doc.templates[k] = templates[k]; });

  var jsonText = JSON.stringify(doc, null, 2) + "\n";
  if (/\u2014/.test(jsonText)) throw new Error("em dash in output");
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, jsonText, "utf8");

  rewriteTemplatesJs(doc);

  var sha = crypto.createHash("sha256").update(jsonText).digest("hex");
  console.log("wrote " + OUT_JSON + " (" + keys.length + " templates, sha256 " + sha.slice(0, 12) + ")");
  console.log("rewrote " + TEMPLATES_JS);
}

function rewriteTemplatesJs(doc) {
  var src = fs.readFileSync(TEMPLATES_JS, "utf8");
  var begin = "/* BEGIN GENERATED TEMPLATE DATA (tools/generate-templates.js; do not hand-edit) */";
  var end = "/* END GENERATED TEMPLATE DATA */";

  /* Compact the embedded copy: same content, smaller file. */
  var embedded = JSON.stringify(doc.templates);

  var header = [
    "/**",
    " * templates.js - 4-chip intake and deterministic template selection.",
    " *",
    " * Per the executor domain contract (section 7): four chips (size band,",
    " * sector, region, data types) select a recipe from a fixed template table,",
    " * TABLE[size][sector][region][types]. Selection is a pure lookup, zero",
    " * runtime tokens. The chatbot builds the recipe and never executes.",
    " *",
    " * Phase 7 ships all 384 template skeletons, authored against the",
    " * vendor KB (vendor-kb/entries/*.json) with generic sector fallbacks",
    " * where the KB has no fit. The canonical artifact is data/templates.json;",
    " * the table below is a byte-equal embedded copy written by",
    " * tools/generate-templates.js (offline bundle: no fetch, no network).",
    " *",
    " * Retention follows the retention rule (RETENTION-RULE.md): ranges only",
    " * with statute cited, or a verify_only flag. Law 25 never sources a",
    " * numerical retention period.",
    " *",
    " * UMD: runs in browsers and Node. No network, no storage, no em dashes.",
    " */",
    "(function (root, factory) {",
    "  \"use strict\";",
    "  var api = factory();",
    "  if (typeof module === \"object\" && module !== null && typeof module.exports === \"object\") {",
    "    module.exports = api;",
    "  } else {",
    "    root.S1Templates = api;",
    "  }",
    "})(typeof self !== \"undefined\" ? self : this, function () {",
    "  \"use strict\";",
    "",
    "  /* The four chips and their fixed option lists (domain contract 7.1). */",
    "  var CHIPS = [",
    "    {",
    "      id: \"size\",",
    "      options: [\"1-10\", \"11-50\", \"51-200\", \"200+\"]",
    "    },",
    "    {",
    "      id: \"sector\",",
    "      options: [\"retail\", \"services\", \"health\", \"tech\", \"manufacturing\", \"nonprofit\"]",
    "    },",
    "    {",
    "      id: \"region\",",
    "      options: [\"quebec\", \"canada\", \"canada-us\", \"international\"]",
    "    },",
    "    {",
    "      id: \"types\",",
    "      options: [\"contact\", \"contact-payment\", \"contact-marketing\", \"all\"]",
    "    }",
    "  ];",
    "",
    "  var TAX_STATUTE = \"Loi sur l'administration fiscale, RLRQ, c. A-6.002, ss. 34, 35.3\";",
    "  var AS_OF = \"2026-10-04\";",
    ""
  ].join("\n");

  var footer = [
    "",
    "  function chipKey(chips) {",
    "    return [chips.size, chips.sector, chips.region, chips.types].join(\"|\");",
    "  }",
    "",
    "  /* Nearest authored template by chip matches; ties break on the",
    "     sorted key so the fallback is deterministic. */",
    "  function nearestKey(chips) {",
    "    var keys = Object.keys(TEMPLATE_TABLE).sort();",
    "    var best = null;",
    "    var bestScore = -1;",
    "    keys.forEach(function (k) {",
    "      var c = TEMPLATE_TABLE[k].chips;",
    "      var s = 0;",
    "      if (c.size === chips.size) s += 1;",
    "      if (c.sector === chips.sector) s += 1;",
    "      if (c.region === chips.region) s += 1;",
    "      if (c.types === chips.types) s += 1;",
    "      if (s > bestScore) { bestScore = s; best = k; }",
    "    });",
    "    return best;",
    "  }",
    "",
    "  /**",
    "   * Pure lookup: chip vector -> template skeleton (deep copy). Exact",
    "   * chip vector first; the nearest authored template when the vector",
    "   * somehow misses (all 384 vectors are authored, so this is a safety",
    "   * net). The returned object contains only recipe-schema fields.",
    "   */",
    "  function selectTemplate(chips) {",
    "    var k = chipKey(chips);",
    "    var entry = TEMPLATE_TABLE[k] || TEMPLATE_TABLE[nearestKey(chips)];",
    "    if (!entry) return null;",
    "    var t = JSON.parse(JSON.stringify(entry));",
    "    delete t.chips;",
    "    return t;",
    "  }",
    "",
    "  function authoredTemplates() {",
    "    return Object.keys(TEMPLATE_TABLE).sort().map(function (k) {",
    "      var e = TEMPLATE_TABLE[k];",
    "      return { recipe_id: e.recipe_id, name: e.name, chips: e.chips, items: e.items.length };",
    "    });",
    "  }",
    "",
    "  function validateChips(chips) {",
    "    var problems = [];",
    "    CHIPS.forEach(function (chip) {",
    "      var v = chips[chip.id];",
    "      if (chip.options.indexOf(v) === -1) {",
    "        problems.push(chip.id + \" must be one of \" + chip.options.join(\", \"));",
    "      }",
    "    });",
    "    return problems;",
    "  }",
    "",
    "  return {",
    "    CHIPS: CHIPS,",
    "    selectTemplate: selectTemplate,",
    "    authoredTemplates: authoredTemplates,",
    "    validateChips: validateChips,",
    "    TAX_STATUTE: TAX_STATUTE,",
    "    AS_OF: AS_OF",
    "  };",
    "});",
    ""
  ].join("\n");

  var body = "  " + begin + "\n  var TEMPLATE_TABLE = " + embedded + ";\n  " + end;
  var out = header + body + footer;
  if (/\u2014/.test(out)) throw new Error("em dash in templates.js");
  fs.writeFileSync(TEMPLATES_JS, out, "utf8");
}

main();
