/**
 * engine.test.js
 *
 * node:test suite for the Phase 1 import engine. Run: node --test engine.test.js
 * from this directory. No DOM, no network.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { mapColumns, splitSections } = require("./column-mapper");
const { toCanonicalModel, normalizeCategoryEnum } = require("./canonical-model");
const { validate } = require("./validate");
const { proposeCategory } = require("./edge-categorizer");
const { buildState } = require("./state-builder");
const {
  parseSpreadsheetML,
  buildSpreadsheetML,
  sheetsToState,
} = require("./spreadsheetml-parser");

// ---------------------------------------------------------------------------
// Fixtures. Headers below were read from the real shipped template
// (Data-Inventory-Template.xlsx, verified 2026-10-04 with openpyxl); the rows
// are the actual EXAMPLE 1 - Cafe Nord example rows.
// ---------------------------------------------------------------------------

const SYSTEMS_HEADERS = [
  "System / application name", "Type", "Data categories", "Purposes of use",
  "Lawful basis", "Retention period", "Storage location", "Owner / department", "Notes",
];
const FLOWS_HEADERS = [
  "From (system)", "To (system)", "Data categories transferred", "Purpose of transfer",
  "Cross-border?", "Destination", "Safeguards", "Notes",
];

const TEMPLATE_SYSTEMS_ROWS = [
  ["TEMPLATE - fill in your own systems below.", null, null, null, null, null, null, null, null],
  SYSTEMS_HEADERS,
  ["Website checkout form", "Collection point", "customer data, payment info", "Process online orders", "Consent", "Transaction + 7 years (tax law)", "Quebec", "E-commerce", null],
  ["POS terminals (Square)", "Collection point", "customer data, payment info", "In-store sales", "Contract", "7 years (tax law)", "Canada", "Retail ops", null],
  ["Shopify", "Internal system", "customer data, order history", "Order management", "Contract", "7 years (tax law)", "Canada", "E-commerce", null],
  ["Klaviyo", "Third party", "marketing consents, customer data", "Email marketing", "Consent", "Until consent withdrawn + 3 years", "United States", "Marketing", "Cross-border assessment filed Mar 2026"],
];

const TEMPLATE_FLOWS_ROWS = [
  ["TEMPLATE - fill in your own data flows below.", null, null, null, null, null, null, null],
  FLOWS_HEADERS,
  ["Website checkout form", "Shopify", "customer data, payment info", "Order processing", "No", null, "TLS in transit", null],
  ["Shopify", "Klaviyo", "customer data, marketing consents", "Email campaigns", "Yes", "United States", "DPA + SCCs; assessment filed", null],
];

describe("column-mapper", () => {
  it("guesses the real template Systems headers (header on row 2)", () => {
    const result = mapColumns({ name: "TEMPLATE - Systems", rows: TEMPLATE_SYSTEMS_ROWS });
    assert.equal(result.kind, "template-systems");
    assert.equal(result.headerRow, 1);
    assert.equal(result.confidence, 1.0);
    assert.deepEqual(result.mapping, {
      systemName: 0, type: 1, dataCategories: 2, purposes: 3,
      lawfulBasis: 4, retention: 5, storageLocation: 6, owner: 7, notes: 8,
    });
    assert.deepEqual(result.unmappedHeaders, []);
  });

  it("guesses the real template Data flows headers", () => {
    const result = mapColumns({ name: "TEMPLATE - Data flows", rows: TEMPLATE_FLOWS_ROWS });
    assert.equal(result.kind, "template-flows");
    assert.equal(result.headerRow, 1);
    assert.equal(result.confidence, 1.0);
    assert.deepEqual(result.mapping, {
      from: 0, to: 1, dataCategories: 2, purpose: 3,
      crossBorder: 4, destination: 5, safeguards: 6, notes: 7,
    });
  });

  it("detects the exporter's Nodes sheet with confidence 1.0", () => {
    const rows = [["Some disclaimer text"], [""], ["Label", "Type"], ["Shopify", "System"]];
    const result = mapColumns({ name: "Nodes", rows });
    assert.equal(result.kind, "exporter-nodes");
    assert.equal(result.confidence, 1.0);
    assert.deepEqual(result.mapping, { label: 0, type: 1 });
    assert.deepEqual(result.unmappedHeaders, []);
  });

  it("detects the exporter's FR sheets with confidence 1.0", () => {
    const rows = [["Avertissement"], [""], ["\u00c9tiquette", "Type"], ["Shopify", "Syst\u00e8me"]];
    const r1 = mapColumns({ name: "N\u0153uds", rows });
    assert.equal(r1.kind, "exporter-nodes");
    assert.equal(r1.confidence, 1.0);
    const r2 = mapColumns({
      name: "Liens",
      rows: [["De", "Vers", "Cat\u00e9gorie"], ["Shopify", "Klaviyo", "Marketing / consentement"]],
    });
    assert.equal(r2.kind, "exporter-connections");
    assert.equal(r2.confidence, 1.0);
  });

  it("returns unknown for unrecognized headers", () => {
    const result = mapColumns({ name: "Weird", rows: [["foo", "bar", "baz"], ["a", "b", "c"]] });
    assert.equal(result.kind, "unknown");
    assert.equal(result.confidence, 0);
  });

  it("splits a stacked EXAMPLE sheet into Systems + Data flows sections", () => {
    const rows = [
      ["EXAMPLE 2 - intro line"],
      ["SYSTEMS"],
      ["System / application name", "Type"],
      ["Signup form (app)", "Collection point"],
      [""],
      ["DATA FLOWS"],
      ["From (system)", "To (system)"],
      ["Signup form (app)", "PostgreSQL"],
    ];
    const parts = splitSections({ name: "EXAMPLE 2 - SaaS startup", rows });
    assert.equal(parts.length, 2);
    assert.equal(parts[0].name, "EXAMPLE 2 - SaaS startup (Systems)");
    assert.equal(parts[1].name, "EXAMPLE 2 - SaaS startup (Data flows)");
    // Marker rows are dropped; the intro line joins the first section.
    assert.deepEqual(parts[0].rows[0], ["EXAMPLE 2 - intro line"]);
    assert.deepEqual(parts[0].rows[1], ["System / application name", "Type"]);
    assert.deepEqual(parts[1].rows[0], ["From (system)", "To (system)"]);
    assert.equal(mapColumns(parts[0]).kind, "template-systems");
    assert.equal(mapColumns(parts[1]).kind, "template-flows");
  });

  it("passes sheets without markers through unchanged", () => {
    const sheet = { name: "Systems", rows: [["System / application name"], ["Shopify"]] };
    const parts = splitSections(sheet);
    assert.equal(parts.length, 1);
    assert.equal(parts[0], sheet);
  });

  it("does not treat an exporter sheet or a single-cell data row as a marker", () => {
    const exporter = {
      name: "Nodes",
      rows: [["Draft inventory"], [""], ["Label", "Type"], ["Shopify", "Third party"]],
    };
    assert.equal(splitSections(exporter).length, 1);
    const singleCell = {
      name: "Systems",
      rows: [["System / application name", "Type"], ["A note in one cell", ""]],
    };
    assert.equal(splitSections(singleCell).length, 1);
  });
});

describe("canonical-model type normalization", () => {
  function systemsForType(typeString) {
    const rows = [SYSTEMS_HEADERS, ["Test system", typeString, "data", "use", "Consent", "7 years", "Quebec", "Ops", null]];
    const mapped = mapColumns({ name: "TEMPLATE - Systems", rows });
    return toCanonicalModel(mapped, rows);
  }

  it("normalizes all template/guide type variants", () => {
    const cases = [
      ["Collection point", "collection"],
      ["Internal system", "system"],
      ["System", "system"],
      ["Third party", "thirdparty"],
      ["Destruction / disposal", "destruction"],
      ["Secure destruction", "destruction"],
      ["collection", "collection"],
      ["  INTERNAL  SYSTEM ", "system"],
    ];
    for (const [raw, expected] of cases) {
      const { systems, rejected } = systemsForType(raw);
      assert.equal(rejected.length, 0, `type '${raw}' should not be rejected`);
      assert.equal(systems[0].type, expected, `type '${raw}'`);
    }
  });

  it("rejects unknown type strings without guessing (no-silent-guess invariant)", () => {
    const rows = [SYSTEMS_HEADERS, ["Mystery box", "Data lake thing", "data", "use", "Consent", "7 years", "Quebec", "Ops", null]];
    const mapped = mapColumns({ name: "TEMPLATE - Systems", rows });
    const { systems, rejected } = toCanonicalModel(mapped, rows);
    assert.equal(systems.length, 0);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].kind, "system");
    assert.match(rejected[0].reason, /not a known type/);
  });

  it("carries the inventory fields through", () => {
    const rows = [SYSTEMS_HEADERS, ["Klaviyo", "Third party", "marketing consents", "Email marketing", "Consent", "Until withdrawn + 3 years", "United States", "Marketing", "note"]];
    const mapped = mapColumns({ name: "TEMPLATE - Systems", rows });
    const { systems } = toCanonicalModel(mapped, rows);
    assert.equal(systems[0].lawfulBasis, "Consent");
    assert.equal(systems[0].retention, "Until withdrawn + 3 years");
    assert.equal(systems[0].storageLocation, "United States");
    assert.equal(systems[0].owner, "Marketing");
  });
});

describe("canonical-model exporter category display names", () => {
  const CONN_HEADERS = ["From", "To", "Category"];
  function connsForCategory(catDisplay) {
    const rows = [CONN_HEADERS, ["Shopify", "Klaviyo", catDisplay]];
    const mapped = mapColumns({ name: "Connections", rows });
    assert.equal(mapped.kind, "exporter-connections");
    return toCanonicalModel(mapped, rows);
  }
  it("resolves EN display names to enums", () => {
    assert.equal(normalizeCategoryEnum("Contact / identity"), "contact");
    assert.equal(normalizeCategoryEnum("Payment"), "payment");
    assert.equal(normalizeCategoryEnum("Marketing / consent"), "marketing");
  });
  it("resolves FR display names to enums", () => {
    assert.equal(normalizeCategoryEnum("Contact / identité"), "contact");
    assert.equal(normalizeCategoryEnum("Paiement"), "payment");
    assert.equal(normalizeCategoryEnum("Marketing / consentement"), "marketing");
  });
  it("keeps bare enums and rejects unknown values", () => {
    assert.equal(normalizeCategoryEnum("contact"), "contact");
    assert.equal(normalizeCategoryEnum("Bogus"), null);
    assert.equal(normalizeCategoryEnum(""), null);
  });
  it("sets edgeCategory from display names so round-trip flows carry no MISSING_CATEGORY flag", () => {
    const cm = connsForCategory("Contact / identity");
    assert.equal(cm.flows.length, 1);
    assert.equal(cm.flows[0].edgeCategory, "contact");
    const flags = validate({ systems: [], flows: cm.flows });
    assert.ok(!flags.some((f) => f.code === "MISSING_CATEGORY"),
      "display-name categories must not raise MISSING_CATEGORY");
  });
  it("an unresolvable category still raises MISSING_CATEGORY", () => {
    const cm = connsForCategory("Bogus");
    assert.equal(cm.flows[0].edgeCategory, null);
    const flags = validate({ systems: [], flows: cm.flows });
    assert.ok(flags.some((f) => f.code === "MISSING_CATEGORY" && f.severity === "error"));
  });

  it("resolves FR type display names on exporter-nodes rows", () => {
    const rows = [["Étiquette", "Type"], ["Borne", "Point de collecte"], ["Compta", "Système"]];
    const mapped = mapColumns({ name: "Nœuds", rows });
    assert.equal(mapped.kind, "exporter-nodes");
    const cm = toCanonicalModel(mapped, rows);
    assert.equal(cm.systems.length, 2);
    assert.equal(cm.systems[0].type, "collection");
    assert.equal(cm.systems[1].type, "system");
    assert.equal(cm.rejected.length, 0);
  });

  it("still rejects a genuinely unknown exporter type", () => {
    const rows = [["Label", "Type"], ["Mystery", "Unknown thing"]];
    const mapped = mapColumns({ name: "Nodes", rows });
    const cm = toCanonicalModel(mapped, rows);
    assert.equal(cm.systems.length, 0);
    assert.equal(cm.rejected.length, 1);
  });
});

describe("edge-categorizer", () => {
  it("proposes payment for payment keywords", () => {
    const p = proposeCategory("customer data, payment info");
    assert.equal(p.cat, "payment");
    assert.equal(p.inferred, true);
    assert.match(p.reason, /payment/);
  });

  it("proposes marketing for marketing keywords", () => {
    const p = proposeCategory("marketing consents, customer data");
    assert.equal(p.cat, "marketing");
    assert.equal(p.inferred, true);
  });

  it("defaults to contact and stays marked inferred", () => {
    const p = proposeCategory("customer data, order history");
    assert.equal(p.cat, "contact");
    assert.equal(p.inferred, true);
  });

  it("payment keywords beat marketing keywords", () => {
    const p = proposeCategory("payment info, marketing consents");
    assert.equal(p.cat, "payment");
  });

  it("every proposal carries inferred:true (no-silent-guess invariant)", () => {
    for (const text of ["billing records", "newsletter subs", "identity records", "", null]) {
      assert.equal(proposeCategory(text).inferred, true, `text: ${text}`);
    }
  });
});

describe("validate", () => {
  function brokenModel() {
    return {
      systems: [
        { name: "Shopify", type: "system", sourceRow: 2 },
        { name: "shopify ", type: "system", sourceRow: 3 },
        { name: "Shopify Inc", type: "thirdparty", sourceRow: 4 },
        { name: "Klaviyo", type: "thirdparty", sourceRow: 5 },
      ],
      flows: [
        { from: "Shopify", to: "Ghost Vendor", dataCategories: "data", purpose: "sync", edgeCategory: null, proposedCategory: null, sourceRow: 6 },
        { from: "Shopify", to: "Klaviyo", dataCategories: "marketing consents", purpose: "Email campaigns", edgeCategory: null, proposedCategory: { cat: "marketing", reason: "x", inferred: true }, sourceRow: 7 },
        { from: "Shopify", to: "Klaviyo", dataCategories: "data", purpose: "sync", edgeCategory: "contact", sourceRow: 8 },
      ],
    };
  }

  it("flags dangling refs, duplicates, inconsistent names, missing categories", () => {
    const flags = validate(brokenModel());
    const byCode = {};
    for (const f of flags) (byCode[f.code] = byCode[f.code] || []).push(f);

    assert.equal(byCode.DANGLING_REF.length, 1);
    assert.equal(byCode.DANGLING_REF[0].severity, "error");
    assert.match(byCode.DANGLING_REF[0].message, /Ghost Vendor/);

    assert.equal(byCode.LIKELY_DUPLICATE.length, 1);
    assert.match(byCode.LIKELY_DUPLICATE[0].message, /Shopify/);

    assert.ok(byCode.INCONSISTENT_NAME.length >= 1, "Shopify vs Shopify Inc should flag");
    assert.ok(byCode.INCONSISTENT_NAME.every((f) => f.severity === "warning"));

    assert.equal(byCode.MISSING_CATEGORY.length, 2);
    const severities = byCode.MISSING_CATEGORY.map((f) => f.severity).sort();
    assert.deepEqual(severities, ["error", "warning"]); // no proposal vs unconfirmed proposal
  });

  it("stays quiet on a clean model", () => {
    const flags = validate({
      systems: [
        { name: "Website checkout form", type: "collection", sourceRow: 2 },
        { name: "Shopify", type: "system", sourceRow: 3 },
        { name: "Klaviyo", type: "thirdparty", sourceRow: 4 },
      ],
      flows: [
        { from: "Website checkout form", to: "Shopify", edgeCategory: "payment", sourceRow: 5 },
        { from: "Shopify", to: "Klaviyo", edgeCategory: "marketing", sourceRow: 6 },
      ],
    });
    assert.deepEqual(flags, []);
  });
});

describe("state-builder", () => {
  function cafeNordModel() {
    const sm = mapColumns({ name: "TEMPLATE - Systems", rows: TEMPLATE_SYSTEMS_ROWS });
    const fm = mapColumns({ name: "TEMPLATE - Data flows", rows: TEMPLATE_FLOWS_ROWS });
    const a = toCanonicalModel(sm, TEMPLATE_SYSTEMS_ROWS);
    const b = toCanonicalModel(fm, TEMPLATE_FLOWS_ROWS);
    return { systems: a.systems, flows: b.flows, rejected: [...a.rejected, ...b.rejected] };
  }

  it("builds the frozen guide state shape with n1..nN ids and no gaps", () => {
    const model = cafeNordModel();
    const confirmed = { categories: { 0: "payment", 1: "marketing" } };
    const state = buildState(model, confirmed);
    const ids = Object.keys(state.nodes);
    assert.deepEqual(ids, ["n1", "n2", "n3", "n4"]);
    assert.equal(state.seq, 4);
    assert.deepEqual(state.nodes.n1, { type: "collection", x: 80, y: 80, label: "Website checkout form" });
    assert.equal(state.nodes.n3.type, "system");
    assert.equal(state.nodes.n4.type, "thirdparty");
    assert.deepEqual(state.edges, [
      { a: "n1", b: "n3", cat: "payment" },
      { a: "n3", b: "n4", cat: "marketing" },
    ]);
    assert.deepEqual(state.rejected, []);
  });

  it("keeps every coordinate inside the builder clamp", () => {
    const systems = Array.from({ length: 12 }, (_, i) => ({
      name: `System ${i}`, type: i % 4 === 0 ? "destruction" : ["collection", "system", "thirdparty"][i % 3],
      sourceRow: i + 2,
    }));
    const state = buildState({ systems, flows: [] }, { categories: {} });
    for (const id of Object.keys(state.nodes)) {
      const n = state.nodes[id];
      assert.ok(n.x >= 40 && n.x <= 600, `${id} x=${n.x}`);
      assert.ok(n.y >= 40 && n.y <= 380, `${id} y=${n.y}`);
      assert.ok(["collection", "system", "thirdparty", "destruction"].includes(n.type));
    }
    assert.equal(state.seq, 12);
  });

  it("excludes unconfirmed and dangling flows, and reports them", () => {
    const model = cafeNordModel();
    model.flows.push({ from: "Shopify", to: "Nowhere Ltd", dataCategories: "d", purpose: "p", edgeCategory: null, proposedCategory: null, sourceRow: 9 });
    const state = buildState(model, { categories: { 0: "payment" } }); // flow 1 unconfirmed, flow 2 dangling
    assert.equal(state.edges.length, 1);
    assert.equal(state.rejected.length, 2);
    assert.ok(state.rejected.every((r) => r.kind === "flow"));
  });

  it("unknown types never reach state (rejected upstream, never in nodes)", () => {
    const rows = [SYSTEMS_HEADERS, ["Mystery", "Data lake thing", "d", "u", "Consent", "7y", "Quebec", "Ops", null]];
    const mapped = mapColumns({ name: "TEMPLATE - Systems", rows });
    const model = toCanonicalModel(mapped, rows);
    const state = buildState(model, { categories: {} });
    assert.deepEqual(state.nodes, {});
    assert.equal(state.seq, 0);
    assert.equal(model.rejected.length, 1);
  });
});

describe("spreadsheetml-parser round-trip", () => {
  const KNOWN_STATE = {
    nodes: {
      n1: { type: "collection", x: 80, y: 80, label: "Website checkout form" },
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

  for (const lang of ["en", "fr"]) {
    it(`round-trips the exporter format (${lang}): state -> SpreadsheetML -> state`, () => {
      const xml = buildSpreadsheetML(KNOWN_STATE, lang);
      const sheets = parseSpreadsheetML(xml);
      assert.equal(sheets.length, 2);

      // The column mapper must see the site's own export with confidence 1.0.
      const kinds = sheets.map((s) => mapColumns(s));
      assert.deepEqual(kinds.map((k) => k.kind).sort(), ["exporter-connections", "exporter-nodes"]);
      assert.ok(kinds.every((k) => k.confidence === 1.0));

      const recovered = sheetsToState(sheets);
      assert.equal(recovered.seq, 4);

      const labelToId = {};
      for (const [id, n] of Object.entries(recovered.nodes)) labelToId[n.label] = id;
      for (const [origId, n] of Object.entries(KNOWN_STATE.nodes)) {
        const recId = labelToId[n.label];
        assert.ok(recId, `node '${n.label}' recovered`);
        assert.equal(recovered.nodes[recId].type, n.type);
      }
      const edgeKey = (e, idToLabel) => [idToLabel[e.a], idToLabel[e.b], e.cat].join("|");
      const origByLabel = {};
      for (const [id, n] of Object.entries(KNOWN_STATE.nodes)) origByLabel[id] = n.label;
      const recIdToLabel = {};
      for (const [id, n] of Object.entries(recovered.nodes)) recIdToLabel[id] = n.label;
      assert.deepEqual(
        recovered.edges.map((e) => edgeKey(e, recIdToLabel)).sort(),
        KNOWN_STATE.edges.map((e) => edgeKey(e, origByLabel)).sort()
      );
    });
  }

  it("skips the disclaimer and blank rows on the Nodes sheet", () => {
    const xml = buildSpreadsheetML(KNOWN_STATE, "en");
    const sheets = parseSpreadsheetML(xml);
    const nodesSheet = sheets.find((s) => s.name === "Nodes");
    assert.equal(nodesSheet.rows[0][0], "Draft inventory for review. Not legal advice.");
    assert.deepEqual(nodesSheet.rows[1], [""]);
    assert.deepEqual(nodesSheet.rows[2], ["Label", "Type"]);
    assert.equal(nodesSheet.rows.length, 7); // disclaimer + blank + header + 4 nodes
  });

  it("handles escaped entities in labels", () => {
    const state = {
      nodes: { n1: { type: "system", x: 1, y: 1, label: "R&D <core> & \"systems\"" } },
      edges: [],
      seq: 1,
    };
    const sheets = parseSpreadsheetML(buildSpreadsheetML(state, "en"));
    const recovered = sheetsToState(sheets);
    assert.equal(recovered.nodes.n1.label, "R&D <core> & \"systems\"");
  });
});

describe("end-to-end: template in, frozen state out", () => {
  it("the full pipeline from raw template rows to guide state", () => {
    const sm = mapColumns({ name: "TEMPLATE - Systems", rows: TEMPLATE_SYSTEMS_ROWS });
    const fm = mapColumns({ name: "TEMPLATE - Data flows", rows: TEMPLATE_FLOWS_ROWS });
    assert.equal(sm.kind, "template-systems");
    assert.equal(fm.kind, "template-flows");

    const sa = toCanonicalModel(sm, TEMPLATE_SYSTEMS_ROWS);
    const fa = toCanonicalModel(fm, TEMPLATE_FLOWS_ROWS);
    assert.equal(sa.systems.length, 4);
    assert.equal(fa.flows.length, 2);
    // Every template flow carries an inferred proposal (free text, no category column).
    assert.ok(fa.flows.every((f) => f.proposedCategory && f.proposedCategory.inferred === true));

    const flags = validate({ systems: sa.systems, flows: fa.flows });
    // Both flows await category confirmation: two MISSING_CATEGORY warnings, no errors.
    const missing = flags.filter((f) => f.code === "MISSING_CATEGORY");
    assert.equal(missing.length, 2);
    assert.ok(missing.every((f) => f.severity === "warning"));
    assert.ok(flags.every((f) => f.severity === "warning"));

    const state = buildState(
      { systems: sa.systems, flows: fa.flows },
      { categories: { 0: fa.flows[0].proposedCategory.cat, 1: fa.flows[1].proposedCategory.cat } }
    );
    assert.equal(state.seq, 4);
    assert.equal(state.edges.length, 2);
    assert.deepEqual(state.rejected, []);
  });
});
