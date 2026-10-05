/* engine-bundle.js
 * GENERATED FILE. Do not edit by hand.
 * Built by tools/bundle-engine.mjs from the engine/*.js sources.
 * Exposes window.DMEngine.
 */
(function () {
"use strict";
var __registry = {};
function __register(name, factory) { __registry[name] = { factory: factory, ran: false, exports: {} }; }
function __require(p) {
  var name = String(p).replace(/^\.\//, "");
  var m = __registry[name];
  if (!m) throw new Error("DMEngine: unknown module '" + p + "'");
  if (!m.ran) { m.ran = true; var module = { exports: m.exports }; m.factory(__require, module, module.exports); m.exports = module.exports; }
  return m.exports;
}
__register("column-mapper", function (require, module, exports) {
/**
 * column-mapper.js
 *
 * Header detection and smart column guessing for the Phase 1 import pipeline.
 *
 * Input:  sheet as { name, rows: string[][] } (raw rows from an xlsx/csv parse).
 * Output: per-sheet { kind, mapping, confidence, unmappedHeaders, headerRow }.
 *
 * Four known column sets are recognized:
 *   template-systems      - the 9-column Systems sheet of the movahedi.ca template
 *   template-flows        - the 8-column Data flows sheet of the movahedi.ca template
 *   exporter-nodes        - the site's own SpreadsheetML Nodes / Noeuds sheet
 *   exporter-connections  - the site's own SpreadsheetML Connections / Liens sheet
 *
 * Exporter-format detection (sheet name Nodes/Noeuds or Connections/Liens plus the
 * matching header signature) returns kind exporter-* with confidence 1.0: the site's
 * own export round-trips with zero mapping step.
 *
 * Pure logic: no DOM, no network. Runs in Node and in a Web Worker.
 */

// Canonical field lists per known column set.
const COLUMN_SETS = {
  "template-systems": [
    "systemName", "type", "dataCategories", "purposes",
    "lawfulBasis", "retention", "storageLocation", "owner", "notes",
  ],
  "template-flows": [
    "from", "to", "dataCategories", "purpose",
    "crossBorder", "destination", "safeguards", "notes",
  ],
  "exporter-nodes": ["label", "type"],
  "exporter-connections": ["from", "to", "category"],
};

// Aliases for each canonical field, matched against the normalized header.
// Normalization: trim, collapse whitespace, lowercase, strip trailing
// parenthetical suffixes ("from (system)" -> "from").
const ALIASES = {
  "template-systems": {
    systemName: ["system / application name", "system name", "system", "application name", "nom du systeme"],
    type: ["type", "system type", "node type", "type de noeud"],
    dataCategories: ["data categories", "categories de donnees", "donnees"],
    purposes: ["purposes of use", "purpose", "purposes", "fins d'utilisation", "usage"],
    lawfulBasis: ["lawful basis", "legal basis", "basis", "fondement juridique"],
    retention: ["retention period", "retention", "conservation"],
    storageLocation: ["storage location", "location", "storage", "emplacement"],
    owner: ["owner / department", "owner", "department", "proprietaire", "responsable"],
    notes: ["notes", "commentaires"],
  },
  "template-flows": {
    from: ["from", "source", "de"],
    to: ["to", "vers"],
    dataCategories: ["data categories transferred", "data categories", "categories de donnees", "donnees transferees"],
    purpose: ["purpose of transfer", "purpose", "purposes", "objet du transfert"],
    crossBorder: ["cross-border?", "cross border", "crossborder", "transfrontalier"],
    destination: ["destination", "pays de destination"],
    safeguards: ["safeguards", "safeguard", "mesures de protection", "garanties"],
    notes: ["notes", "commentaires"],
  },
  "exporter-nodes": {
    label: ["label", "etiquette"],
    type: ["type"],
  },
  "exporter-connections": {
    from: ["from", "de"],
    to: ["to", "vers"],
    category: ["category", "categorie"],
  },
};

// Sheet-name signals for the exporter's own format (EN + FR).
const EXPORTER_SHEET_NAMES = {
  nodes: new Set(["nodes", "noeuds", "nœuds"]),
  connections: new Set(["connections", "liens"]),
};

function normalizeHeader(value) {
  let s = String(value == null ? "" : value).trim().toLowerCase();
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/œ/g, "oe");
  s = s.replace(/\s+/g, " ");
  // Strip trailing parenthetical suffixes: "from (system)" -> "from".
  s = s.replace(/\s*\([^()]*\)\s*$/, "").trim();
  return s;
}

// Normalize sheet names the same loose way (accents are kept as-is except oe ligature).
function normalizeSheetName(name) {
  return String(name == null ? "" : name).trim().toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/œ/g, "oe");
}

// Section markers for template worksheets that stack the Systems and the
// Data-flows sections in a single sheet (the movahedi.ca template's EXAMPLE
// sheets do exactly this: an intro line, a "SYSTEMS" section, then a
// "DATA FLOWS" section). A marker row carries the section name in the first
// cell and nothing else; any other single-cell row is not a marker.
const SECTION_MARKERS = {
  systems: new Set(["systems", "systemes"]),
  flows: new Set(["data flows", "flows", "flux de donnees", "flux"]),
};

function sectionMarkerKind(row) {
  if (!row || row.length === 0) return null;
  const first = normalizeHeader(row[0]);
  if (!first) return null;
  const restEmpty = row.slice(1).every((c) => String(c == null ? "" : c).trim() === "");
  if (!restEmpty) return null;
  if (SECTION_MARKERS.systems.has(first)) return "systems";
  if (SECTION_MARKERS.flows.has(first)) return "flows";
  return null;
}

/**
 * Split a worksheet that stacks template sections ("SYSTEMS" / "DATA FLOWS")
 * into one virtual sheet per section, so each section runs the normal
 * header-detect -> column-map -> canonical-model pipeline on its own.
 * Sheets without section markers pass through unchanged as a single sheet.
 *
 * Rows before the first marker (e.g. the template's intro line) join the
 * first section; the marker rows themselves are not data and are dropped.
 *
 * @param {{name: string, rows: string[][]}} sheet
 * @returns {{name: string, rows: string[][]}[]}
 */
function splitSections(sheet) {
  const rows = (sheet && sheet.rows) || [];
  const kinds = rows.map(sectionMarkerKind);
  if (!kinds.some(Boolean)) return [sheet];
  const out = [];
  const preamble = [];
  let current = null;
  const seen = {};
  rows.forEach((row, i) => {
    const kind = kinds[i];
    if (kind) {
      seen[kind] = (seen[kind] || 0) + 1;
      const suffix = kind === "systems" ? " (Systems)" : " (Data flows)";
      current = {
        name: String(sheet.name == null ? "" : sheet.name) + suffix + (seen[kind] > 1 ? " " + seen[kind] : ""),
        rows: [],
      };
      out.push(current);
    } else if (current) {
      current.rows.push(row);
    } else {
      preamble.push(row);
    }
  });
  if (out.length > 0 && preamble.length > 0) {
    out[0].rows = preamble.concat(out[0].rows);
  }
  return out.filter((s) => s.rows.length > 0);
}

function findHeaderRow(rows) {
  // Template sheets carry an instruction line at row 0 and the header at row 1;
  // the exporter's Nodes sheet has a disclaimer row, a blank row, then headers.
  // Scan the first few rows and pick the one that best matches a known column set.
  const limit = Math.min(rows.length, 6);
  let best = { row: 0, score: -1 };
  for (let r = 0; r < limit; r++) {
    const headers = (rows[r] || []).map(normalizeHeader).filter(Boolean);
    if (headers.length === 0) continue;
    const score = bestKindScore(headers).matched;
    if (score > best.score) best = { row: r, score };
  }
  return best.row;
}

function matchHeader(normalized, aliasSet) {
  for (const field of Object.keys(aliasSet)) {
    if (aliasSet[field].includes(normalized)) return field;
  }
  return null;
}

function bestKindScore(headers) {
  let best = { kind: "unknown", matched: 0, fields: 0, mapping: {}, unmapped: [] };
  for (const kind of Object.keys(COLUMN_SETS)) {
    const aliasSet = ALIASES[kind];
    const mapping = {};
    const matchedFields = new Set();
    const unmapped = [];
    headers.forEach((h, idx) => {
      const field = matchHeader(h, aliasSet);
      if (field && !matchedFields.has(field)) {
        matchedFields.add(field);
        mapping[field] = idx;
      } else if (!field) {
        unmapped.push(h);
      }
    });
    const matched = matchedFields.size;
    if (matched > best.matched) {
      best = { kind, matched, fields: COLUMN_SETS[kind].length, mapping, unmapped };
    }
  }
  return best;
}

function isExporterSignature(kind, headers) {
  // Exporter signature: the exact 2- or 3-header shape of the site's own export.
  if (kind === "exporter-nodes") {
    return headers.length >= 2 &&
      (headers.includes("label") || headers.includes("etiquette")) &&
      headers.includes("type");
  }
  if (kind === "exporter-connections") {
    return headers.length >= 3 &&
      (headers.includes("from") || headers.includes("de")) &&
      (headers.includes("to") || headers.includes("vers")) &&
      (headers.includes("category") || headers.includes("categorie"));
  }
  return false;
}

function exporterKindFromSheetName(name) {
  const n = normalizeSheetName(name);
  if (EXPORTER_SHEET_NAMES.nodes.has(n)) return "exporter-nodes";
  if (EXPORTER_SHEET_NAMES.connections.has(n)) return "exporter-connections";
  return null;
}

/**
 * Map one sheet's headers to a known column set.
 * @param {{name: string, rows: string[][]}} sheet
 * @returns {{kind, mapping, confidence, unmappedHeaders, headerRow}}
 */
function mapColumns(sheet) {
  const rows = (sheet && sheet.rows) || [];
  if (rows.length === 0) {
    return { kind: "unknown", mapping: {}, confidence: 0, unmappedHeaders: [], headerRow: 0 };
  }

  const headerRow = findHeaderRow(rows);
  const headers = (rows[headerRow] || []).map(normalizeHeader).filter(Boolean);

  // Exporter fast path: sheet name plus header signature. Confidence 1.0,
  // identity mapping, no further guessing needed.
  const nameKind = exporterKindFromSheetName(sheet.name);
  if (nameKind && isExporterSignature(nameKind, headers)) {
    const mapping = {};
    headers.forEach((h, idx) => {
      const field = matchHeader(h, ALIASES[nameKind]);
      if (field && mapping[field] === undefined) mapping[field] = idx;
    });
    return {
      kind: nameKind,
      mapping,
      confidence: 1.0,
      unmappedHeaders: [],
      headerRow,
    };
  }

  const best = bestKindScore(headers);
  const minMatches = best.kind === "unknown" ? 1 : 2;
  if (best.matched < minMatches) {
    return {
      kind: "unknown",
      mapping: {},
      confidence: 0,
      unmappedHeaders: headers,
      headerRow,
    };
  }

  return {
    kind: best.kind,
    mapping: best.mapping,
    confidence: best.matched / best.fields,
    unmappedHeaders: best.unmapped,
    headerRow,
  };
}

module.exports = {
  mapColumns,
  splitSections,
  findHeaderRow,
  normalizeHeader,
  COLUMN_SETS,
};

});
__register("edge-categorizer", function (require, module, exports) {
/**
 * edge-categorizer.js
 *
 * The template's "Data categories transferred" column is free text and carries no
 * edge-category column (freeze mismatch #5). The guide needs one of the three
 * fixed edge categories per edge: contact, payment, marketing.
 *
 * This module proposes a category from keyword rules. Every proposal is marked
 * explicitly inferred: true. The UI shows proposals as suggestions for visitor
 * confirmation. Nothing is ever applied silently.
 *
 * Pure logic: no DOM, no network.
 */

const PAYMENT_KEYWORDS = [
  "payment", "billing", "card", "credit card", "invoice", "refund",
  "charge", "transaction", "paiement", "facturation", "carte",
];

const MARKETING_KEYWORDS = [
  "marketing", "consent", "newsletter", "email campaign", "email marketing",
  "subscription", "consentement", "infolettre", "abonnement",
];

function proposeCategory(freeText) {
  const text = String(freeText == null ? "" : freeText).toLowerCase();

  for (const kw of PAYMENT_KEYWORDS) {
    if (text.includes(kw)) {
      return {
        cat: "payment",
        reason: `Matched the payment keyword '${kw}' in '${String(freeText).trim()}'.`,
        inferred: true,
      };
    }
  }
  for (const kw of MARKETING_KEYWORDS) {
    if (text.includes(kw)) {
      return {
        cat: "marketing",
        reason: `Matched the marketing keyword '${kw}' in '${String(freeText).trim()}'.`,
        inferred: true,
      };
    }
  }
  return {
    cat: "contact",
    reason: "No payment or marketing keywords found; contact/identity is the default category.",
    inferred: true,
  };
}

module.exports = { proposeCategory };

});
__register("validate", function (require, module, exports) {
/**
 * validate.js
 *
 * Validation pass over the canonical model. Returns flags[], each:
 *   { severity: "error" | "warning", code, message, row }
 *
 * Codes:
 *   MISSING_CATEGORY  - flow has no usable edge category (no confirmed category;
 *                       warning when a proposal exists awaiting confirmation,
 *                       error when nothing was proposed)
 *   DANGLING_REF      - flow from/to names a system not present in systems[]
 *   LIKELY_DUPLICATE  - two systems with the same normalized name (lowercase,
 *                       punctuation and whitespace stripped)
 *   INCONSISTENT_NAME - two system names that are fuzzy-near (one adds a corporate
 *                       suffix like "Inc", or tiny edit distance). Flagged, never merged.
 *
 * Every flag is data for the UI to render inline. Nothing is auto-fixed.
 *
 * Pure logic: no DOM, no network.
 */

const EDGE_CATS = new Set(["contact", "payment", "marketing"]);
const CORPORATE_SUFFIX = /\b(inc|ltd|llc|corp|corporation|co|sas|sarl|gmbh|senc|s\.e\.n\.c\.?)\.?$/;

function normalizeName(name) {
  return String(name == null ? "" : name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function stripCorporateSuffix(normalized) {
  // Apply to a lightly normalized form (lowercase, single spaces, punctuation kept).
  const s = String(normalized).toLowerCase().replace(/\s+/g, " ").trim();
  return s.replace(CORPORATE_SUFFIX, "").trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
}

function namesAreNear(a, b) {
  if (a === b) return false;
  const plainA = normalizeName(a);
  const plainB = normalizeName(b);
  if (!plainA || !plainB) return false;
  // Corporate suffix: "Shopify" vs "Shopify Inc".
  const sA = normalizeName(stripCorporateSuffix(a));
  const sB = normalizeName(stripCorporateSuffix(b));
  if (sA && sB && sA === sB) return true;
  // One is a prefix of the other with a small length gap.
  const longer = plainA.length >= plainB.length ? plainA : plainB;
  const shorter = plainA.length >= plainB.length ? plainB : plainA;
  if (longer.startsWith(shorter) && longer.length - shorter.length <= 4) return true;
  // Tiny edit distance on reasonably long names.
  if (shorter.length >= 5 && levenshtein(plainA, plainB) <= 2) return true;
  return false;
}

/**
 * @param {{systems: Object[], flows: Object[]}} model canonical model
 * @returns {{severity: string, code: string, message: string, row: number|null}[]}
 */
function validate(model) {
  const flags = [];
  const systems = model.systems || [];
  const flows = model.flows || [];
  const byName = new Map();
  for (const s of systems) {
    const key = normalizeName(s.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(s);
  }

  // LIKELY_DUPLICATE: same normalized name on two system rows.
  for (const entries of byName.values()) {
    if (entries.length > 1) {
      flags.push({
        severity: "warning",
        code: "LIKELY_DUPLICATE",
        message: `Systems ${entries.map((e) => `'${e.name}'`).join(" and ")} look like the same system. Merge them or rename one.`,
        row: entries[0].sourceRow || null,
      });
    }
  }

  // INCONSISTENT_NAME: fuzzy-near but not identical normalized names.
  for (let i = 0; i < systems.length; i++) {
    for (let j = i + 1; j < systems.length; j++) {
      const a = systems[i], b = systems[j];
      if (normalizeName(a.name) === normalizeName(b.name)) continue; // already duplicate-flagged
      if (namesAreNear(a.name, b.name)) {
        flags.push({
          severity: "warning",
          code: "INCONSISTENT_NAME",
          message: `System names '${a.name}' and '${b.name}' look alike. They were kept separate; confirm they are different systems or rename one.`,
          row: a.sourceRow || null,
        });
      }
    }
  }

  // Per-flow checks.
  for (const f of flows) {
    const row = f.sourceRow || null;
    const hasUsableCategory = EDGE_CATS.has(f.edgeCategory);
    if (!hasUsableCategory) {
      if (f.proposedCategory && EDGE_CATS.has(f.proposedCategory.cat)) {
        flags.push({
          severity: "warning",
          code: "MISSING_CATEGORY",
          message: `Flow '${f.from}' to '${f.to}' has a suggested category (${f.proposedCategory.cat}) waiting for your confirmation. Confirm or change it before the edge is drawn.`,
          row,
        });
      } else {
        flags.push({
          severity: "error",
          code: "MISSING_CATEGORY",
          message: `Flow '${f.from}' to '${f.to}' has no edge category. Pick one of contact, payment, or marketing before the edge can be drawn.`,
          row,
        });
      }
    }
    for (const [endpoint, label] of [[f.from, "From"], [f.to, "To"]]) {
      if (!byName.has(normalizeName(endpoint))) {
        flags.push({
          severity: "error",
          code: "DANGLING_REF",
          message: `Flow ${label.toLowerCase()} '${endpoint}' does not match any system on the Systems sheet. Fix the spelling or add the system.`,
          row,
        });
      }
    }
  }

  return flags;
}

module.exports = { validate, normalizeName };

});
__register("canonical-model", function (require, module, exports) {
/**
 * canonical-model.js
 *
 * Converts mapped rows into the canonical import model:
 *   systems[]: { name, type, dataCategories, purposes, lawfulBasis, retention,
 *                storageLocation, owner, notes }
 *   flows[]:   { from, to, dataCategories, purpose, crossBorder, destination,
 *                safeguards, notes, proposedCategory, edgeCategory }
 *
 * Type normalization is explicit and never silent. The table:
 *   "Collection point"      -> collection
 *   "Internal system"       -> system
 *   "System"                -> system
 *   "Third party"           -> thirdparty
 *   "Destruction / disposal"-> destruction
 *   "Secure destruction"    -> destruction
 *   (guide enums pass through unchanged)
 * Any other type string is rejected: the row lands in rejected[] with a reason,
 * never in state.
 *
 * Pure logic: no DOM, no network.
 */

const edgeCategorizer = require("./edge-categorizer");
const { mapCategoryDisplay, mapTypeDisplay } = require("./spreadsheetml-parser");

const GUIDE_TYPES = new Set(["collection", "system", "thirdparty", "destruction"]);

const TYPE_NORMALIZATIONS = {
  "collection point": "collection",
  "internal system": "system",
  "system": "system",
  "third party": "thirdparty",
  "destruction / disposal": "destruction",
  "secure destruction": "destruction",
};

const KNOWN_TYPE_LABELS = [
  '"Collection point"', '"Internal system"', '"System"',
  '"Third party"', '"Destruction / disposal"', '"Secure destruction"',
];

function normalizeType(raw) {
  const s = String(raw == null ? "" : raw).trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return { ok: false, reason: "blank" };
  if (GUIDE_TYPES.has(s)) return { ok: true, type: s };
  if (Object.prototype.hasOwnProperty.call(TYPE_NORMALIZATIONS, s)) {
    return { ok: true, type: TYPE_NORMALIZATIONS[s] };
  }
  return { ok: false, reason: "unknown" };
}

function cell(row, mapping, field) {
  const idx = mapping[field];
  if (idx === undefined || idx === null) return "";
  return String(row[idx] == null ? "" : row[idx]).trim();
}

function isEmptyRow(row) {
  return !row || row.every((c) => c == null || String(c).trim() === "");
}

/**
 * Build the canonical model from mapped rows.
 * @param {{kind: string, mapping: Object, headerRow: number}} mapped
 * @param {string[][]} rows raw sheet rows
 * @returns {{systems: Object[], flows: Object[], rejected: Object[]}}
 */
function toCanonicalModel(mapped, rows) {
  const systems = [];
  const flows = [];
  const rejected = [];
  const { kind, mapping, headerRow } = mapped;

  if (kind !== "template-systems" && kind !== "template-flows" &&
      kind !== "exporter-nodes" && kind !== "exporter-connections") {
    rejected.push({ row: null, kind: "sheet", reason: `Sheet kind '${kind}' is not importable.` });
    return { systems, flows, rejected };
  }

  const dataStart = headerRow + 1;
  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i];
    if (isEmptyRow(row)) continue;
    const sheetRow = i + 1; // 1-based for user-facing messages.

    if (kind === "template-systems" || kind === "exporter-nodes") {
      const name = cell(row, mapping, kind === "template-systems" ? "systemName" : "label");
      if (!name) {
        rejected.push({ row: sheetRow, kind: "system", reason: "Row has no system name; skipped." });
        continue;
      }
      const rawType = cell(row, mapping, "type");
      // The exporter's Nodes sheet carries display names ("Collection point",
      // "Point de collecte", ...); resolve those before enum normalization so
      // both languages round-trip. Template values pass through unchanged.
      const t = normalizeType(mapTypeDisplay(rawType));
      if (!t.ok) {
        rejected.push({
          row: sheetRow,
          kind: "system",
          name,
          reason: t.reason === "blank"
            ? `System '${name}' has no type; expected one of ${KNOWN_TYPE_LABELS.join(", ")}.`
            : `System '${name}' has type '${String(rawType).trim()}', which is not a known type; expected one of ${KNOWN_TYPE_LABELS.join(", ")}.`,
        });
        continue;
      }
      systems.push({
        name,
        type: t.type,
        dataCategories: cell(row, mapping, "dataCategories"),
        purposes: cell(row, mapping, "purposes"),
        lawfulBasis: cell(row, mapping, "lawfulBasis"),
        retention: cell(row, mapping, "retention"),
        storageLocation: cell(row, mapping, "storageLocation"),
        owner: cell(row, mapping, "owner"),
        notes: cell(row, mapping, "notes"),
        sourceRow: sheetRow,
      });
    } else {
      // template-flows or exporter-connections
      const from = cell(row, mapping, "from");
      const to = cell(row, mapping, "to");
      if (!from || !to) {
        rejected.push({
          row: sheetRow,
          kind: "flow",
          reason: `Flow row is missing ${!from ? "'From'" : ""}${!from && !to ? " and " : ""}${!to ? "'To'" : ""}; skipped.`,
        });
        continue;
      }
      const dataCategories = cell(row, mapping, "dataCategories");
      const purpose = cell(row, mapping, "purpose");
      let proposedCategory = null;
      if (kind === "template-flows") {
        // The template has no edge-category column: propose from free text.
        proposedCategory = edgeCategorizer.proposeCategory(`${dataCategories} ${purpose}`);
      }
      flows.push({
        from,
        to,
        dataCategories,
        purpose,
        crossBorder: cell(row, mapping, "crossBorder"),
        destination: cell(row, mapping, "destination"),
        safeguards: cell(row, mapping, "safeguards"),
        notes: cell(row, mapping, "notes"),
        // exporter-connections sheets carry the display name; normalize to enum.
        edgeCategory: kind === "exporter-connections"
          ? normalizeCategoryEnum(cell(row, mapping, "category"))
          : null,
        proposedCategory,
        sourceRow: sheetRow,
      });
    }
  }

  return { systems, flows, rejected };
}

function normalizeCategoryEnum(raw) {
  // The exporter's Connections sheet carries display names ("Contact /
  // identity", "Paiement", ...), not bare enums; resolve both.
  const mapped = mapCategoryDisplay(raw);
  if (["contact", "payment", "marketing"].includes(mapped)) return mapped;
  return null;
}

module.exports = {
  toCanonicalModel,
  normalizeType,
  normalizeCategoryEnum,
};

});
__register("state-builder", function (require, module, exports) {
/**
 * state-builder.js
 *
 * Canonical model + visitor-confirmed edge categories -> the exact frozen guide
 * state: { nodes: {"n1": {type, x, y, label}, ...}, edges: [{a, b, cat}], seq }.
 *
 * This is the same state shape the executor drives (freeze section 3/4):
 * node ids ascend n1..nN with no gaps (recipe convention), types are the guide
 * enums, edge cats are contact/payment/marketing.
 *
 * Auto-layout mirrors the walkthrough's spatial logic: collection points left,
 * internal systems middle, third parties right, destruction along the bottom.
 * Coordinates stay inside the builder clamp: x 40-600, y 40-380.
 *
 * Rows that fail validation (dangling flow reference, unconfirmed edge category)
 * are excluded from state and listed in result.rejected. Nothing is auto-fixed.
 *
 * Pure logic: no DOM, no network.
 */

const { validate, normalizeName } = require("./validate");

const EDGE_CATS = new Set(["contact", "payment", "marketing"]);
const MIN_X = 40, MAX_X = 600, MIN_Y = 40, MAX_Y = 380;

// Column layout per type, mirroring the walkthrough diagram.
const LAYOUT = {
  collection: { x: 80, y0: 80, y1: 320 },
  system: { x: 310, y0: 80, y1: 320 },
  thirdparty: { x: 545, y0: 80, y1: 320 },
  destruction: { y: 340, x0: 80, x1: 545, perRow: 5 },
};

function clampX(x) { return Math.min(MAX_X, Math.max(MIN_X, Math.round(x))); }
function clampY(y) { return Math.min(MAX_Y, Math.max(MIN_Y, Math.round(y))); }

function columnYs(count, y0, y1) {
  if (count === 1) return [(y0 + y1) / 2];
  const out = [];
  for (let i = 0; i < count; i++) out.push(y0 + (i * (y1 - y0)) / (count - 1));
  return out;
}

function layoutPositions(systems) {
  // Group systems by type, keeping first-seen order inside each group.
  const groups = { collection: [], system: [], thirdparty: [], destruction: [] };
  for (const s of systems) groups[s.type].push(s);

  const positions = new Map(); // system -> {x, y}
  for (const type of ["collection", "system", "thirdparty"]) {
    const col = groups[type];
    const ys = columnYs(col.length, LAYOUT[type].y0, LAYOUT[type].y1);
    col.forEach((s, i) => positions.set(s, { x: LAYOUT[type].x, y: ys[i] }));
  }
  const d = groups.destruction;
  d.forEach((s, i) => {
    const row = Math.floor(i / LAYOUT.destruction.perRow);
    const inRow = d.slice(row * LAYOUT.destruction.perRow, (row + 1) * LAYOUT.destruction.perRow);
    const j = i % LAYOUT.destruction.perRow;
    const x = inRow.length === 1
      ? (LAYOUT.destruction.x0 + LAYOUT.destruction.x1) / 2
      : LAYOUT.destruction.x0 + (j * (LAYOUT.destruction.x1 - LAYOUT.destruction.x0)) / (inRow.length - 1);
    positions.set(s, { x, y: LAYOUT.destruction.y - row * 50 });
  });
  return positions;
}

/**
 * @param {{systems: Object[], flows: Object[]}} model canonical model
 * @param {{categories?: Object}} confirmed visitor-confirmed edge categories:
 *        { <flowIndex>: "contact"|"payment"|"marketing" }
 * @returns {{nodes, edges, seq, rejected}}
 */
function buildState(model, confirmed) {
  const categories = (confirmed && confirmed.categories) || {};
  const systems = model.systems || [];
  const flows = model.flows || [];

  const nodes = {};
  const edges = [];
  const rejected = [];

  // Node ids ascend n1..nN with no gaps.
  const positions = layoutPositions(systems);
  const idBySystem = new Map();
  systems.forEach((s, i) => {
    const id = `n${i + 1}`;
    idBySystem.set(s, id);
    const pos = positions.get(s) || { x: 310, y: 200 };
    nodes[id] = {
      type: s.type,
      x: clampX(pos.x),
      y: clampY(pos.y),
      label: s.name,
    };
  });
  const seq = systems.length;

  // Resolve names to node ids (first system wins on normalized ties).
  const idByName = new Map();
  for (const s of systems) {
    const key = normalizeName(s.name);
    if (!idByName.has(key)) idByName.set(key, idBySystem.get(s));
  }

  const seenPairs = new Set();
  flows.forEach((f, flowIndex) => {
    const a = idByName.get(normalizeName(f.from));
    const b = idByName.get(normalizeName(f.to));
    if (!a || !b) {
      const missing = !a ? f.from : f.to;
      rejected.push({
        kind: "flow",
        row: f.sourceRow || null,
        flow: { from: f.from, to: f.to },
        reason: `Flow endpoint '${missing}' does not match any system; edge not drawn.`,
      });
      return;
    }
    const cat = categories[flowIndex] != null ? categories[flowIndex]
      : (f.edgeCategory && EDGE_CATS.has(f.edgeCategory) ? f.edgeCategory : null);
    if (!cat || !EDGE_CATS.has(cat)) {
      rejected.push({
        kind: "flow",
        row: f.sourceRow || null,
        flow: { from: f.from, to: f.to },
        reason: `Flow '${f.from}' to '${f.to}' has no confirmed edge category; edge not drawn.`,
      });
      return;
    }
    const pairKey = [a, b].sort().join("|");
    if (seenPairs.has(pairKey)) return; // same duplicate-pair rule as the guide
    seenPairs.add(pairKey);
    edges.push({ a, b, cat });
  });

  return { nodes, edges, seq, rejected };
}

module.exports = { buildState, LAYOUT };

});
__register("spreadsheetml-parser", function (require, module, exports) {
/**
 * spreadsheetml-parser.js
 *
 * Custom parser covering exactly the output of the site's own SpreadsheetML
 * .xls exporter (freeze section 5). No SheetJS dependency, no DOM.
 *
 * Exporter shape it handles:
 *   - UTF-8 BOM prefix, SpreadsheetML XML (ss namespace).
 *   - Sheet "Nodes" (EN) / "Noeuds" (FR): rows in order [disclaimer], [""],
 *     header, then one row per node: [label, typeDisplayName].
 *   - Sheet "Connections" (EN) / "Liens" (FR): rows in order header, then one
 *     row per edge: [label(a), label(b), categoryDisplayName].
 *   - EN type display names: "Collection point", "System", "Third party",
 *     "Secure destruction". EN category names: "Contact / identity", "Payment",
 *     "Marketing / consent".
 *   - FR type display names: "Point de collecte", "Systeme", "Tiers",
 *     "Destruction securisee". FR category names: "Contact / identite",
 *     "Paiement", "Marketing / consentement".
 *
 * Display names are mapped back to guide enums in both languages. The parser
 * returns sheets in the same {name, rows} shape the column mapper expects, so
 * the site's own export is detected as kind exporter-* with confidence 1.0.
 *
 * Pure logic: no DOM, no network. Runs in Node and in a Web Worker.
 */

const TYPE_DISPLAY_TO_ENUM = {
  "collection point": "collection",
  "system": "system",
  "third party": "thirdparty",
  "secure destruction": "destruction",
  "point de collecte": "collection",
  "systeme": "system",
  "tiers": "thirdparty",
  "destruction securisee": "destruction",
};

const CATEGORY_DISPLAY_TO_ENUM = {
  "contact / identity": "contact",
  "payment": "payment",
  "marketing / consent": "marketing",
  "contact / identite": "contact",
  "paiement": "payment",
  "marketing / consentement": "marketing",
};

// Display names the exporter writes (used by buildSpreadsheetML).
const TYPE_ENUM_TO_DISPLAY = {
  en: {
    collection: "Collection point",
    system: "System",
    thirdparty: "Third party",
    destruction: "Secure destruction",
  },
  fr: {
    collection: "Point de collecte",
    system: "Syst\u00e8me",
    thirdparty: "Tiers",
    destruction: "Destruction s\u00e9curis\u00e9e",
  },
};

const CATEGORY_ENUM_TO_DISPLAY = {
  en: {
    contact: "Contact / identity",
    payment: "Payment",
    marketing: "Marketing / consent",
  },
  fr: {
    contact: "Contact / identit\u00e9",
    payment: "Paiement",
    marketing: "Marketing / consentement",
  },
};

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&"); // last: &amp; must decode after the others
}

// Accent-insensitive comparison key for display names.
function displayKey(s) {
  return String(s).trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const TYPE_ENUM_LOOKUP = {};
for (const [display, en] of Object.entries(TYPE_DISPLAY_TO_ENUM)) {
  TYPE_ENUM_LOOKUP[displayKey(display)] = en;
}
const CATEGORY_ENUM_LOOKUP = {};
for (const [display, en] of Object.entries(CATEGORY_DISPLAY_TO_ENUM)) {
  CATEGORY_ENUM_LOOKUP[displayKey(display)] = en;
}

function mapTypeDisplay(raw) {
  const en = TYPE_ENUM_LOOKUP[displayKey(raw)];
  return en || String(raw).trim();
}

function mapCategoryDisplay(raw) {
  const en = CATEGORY_ENUM_LOOKUP[displayKey(raw)];
  return en || String(raw).trim();
}

function extractDataCells(rowInner) {
  // One entry per <Cell> in document order; empty cells become "".
  const cells = [];
  const cellRe = /<Cell\b[^>]*>([\s\S]*?)<\/Cell>/gi;
  let m;
  while ((m = cellRe.exec(rowInner)) !== null) {
    const dataRe = /<Data\b[^>]*>([\s\S]*?)<\/Data>/i;
    const d = dataRe.exec(m[1]);
    cells.push(d ? unescapeXml(d[1]) : "");
  }
  return cells;
}

/**
 * Parse the exporter's SpreadsheetML string.
 * @param {string} xml the .xls text (BOM tolerated)
 * @returns {{name: string, rows: string[][]}[]} sheets in column-mapper shape
 */
function parseSpreadsheetML(xml) {
  const text = String(xml).replace(/^\uFEFF/, "");
  const sheets = [];
  const wsRe = /<Worksheet\b[^>]*\bss:Name="([^"]+)"[^>]*>([\s\S]*?)<\/Worksheet>/gi;
  let wsm;
  while ((wsm = wsRe.exec(text)) !== null) {
    const name = unescapeXml(wsm[1]);
    const rows = [];
    const rowRe = /<Row\b[^>]*>([\s\S]*?)<\/Row>/gi;
    let rm;
    while ((rm = rowRe.exec(wsm[2])) !== null) {
      rows.push(extractDataCells(rm[1]));
    }
    sheets.push({ name, rows });
  }
  return sheets;
}

/**
 * Find the Nodes/Noeuds and Connections/Liens sheets in parsed output.
 * @param {{name: string, rows: string[][]}[]} sheets
 * @returns {{nodes: Object|null, connections: Object|null}}
 */
function findInventorySheets(sheets) {
  let nodes = null, connections = null;
  for (const s of sheets) {
    const n = displayKey(s.name).replace(/œ/g, "oe");
    if (["nodes", "noeuds"].includes(n)) nodes = s;
    if (["connections", "liens"].includes(n)) connections = s;
  }
  return { nodes, connections };
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cell(v) {
  return `<Cell><Data ss:Type="String">${escapeXml(v)}</Data></Cell>`;
}

/**
 * Build the exporter's SpreadsheetML string from a frozen guide state.
 * Mirrors freeze section 5 exactly (row order, header names, BOM).
 * @param {{nodes: Object, edges: Object[]}} state
 * @param {"en"|"fr"} lang
 * @returns {string}
 */
function buildSpreadsheetML(state, lang) {
  const l = lang === "fr" ? "fr" : "en";
  const typeName = TYPE_ENUM_TO_DISPLAY[l];
  const catName = CATEGORY_ENUM_TO_DISPLAY[l];
  const nodesSheet = l === "fr" ? "N\u0153uds" : "Nodes";
  const linksSheet = l === "fr" ? "Liens" : "Connections";
  const disclaimer = l === "fr"
    ? "Brouillon \u00e0 r\u00e9viser. Ceci n\u2019est pas un avis juridique."
    : "Draft inventory for review. Not legal advice.";

  const ids = Object.keys(state.nodes).sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
  const labelOf = (id) => (state.nodes[id] && state.nodes[id].label) || "";

  const nodeRows = [
    `<Row>${cell(disclaimer)}</Row>`,
    `<Row>${cell("")}</Row>`,
    `<Row>${cell(l === "fr" ? "\u00c9tiquette" : "Label")}${cell("Type")}</Row>`,
    ...ids.map((id) => {
      const n = state.nodes[id];
      return `<Row>${cell(n.label)}${cell(typeName[n.type] || n.type)}</Row>`;
    }),
  ];
  const edgeRows = [
    `<Row>${cell(l === "fr" ? "De" : "From")}${cell(l === "fr" ? "Vers" : "To")}${cell(l === "fr" ? "Cat\u00e9gorie" : "Category")}</Row>`,
    ...state.edges.map((e) =>
      `<Row>${cell(labelOf(e.a))}${cell(labelOf(e.b))}${cell(catName[e.cat] || e.cat)}</Row>`),
  ];

  const sheet = (name, rows) =>
    `<Worksheet ss:Name="${name}"><Table>${rows.join("")}</Table></Worksheet>`;

  return "\uFEFF" +
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ` +
    `xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">` +
    sheet(nodesSheet, nodeRows) +
    sheet(linksSheet, edgeRows) +
    `</Workbook>`;
}

/**
 * Convert parsed inventory sheets back to frozen guide state.
 * Node display types / edge display categories map to enums (both languages).
 * Coordinates are not in the export (the guide does not export them); callers
 * that need positions should run the result through state-builder's layout.
 * @param {{name: string, rows: string[][]}[]} sheets
 * @returns {{nodes: Object, edges: Object[], seq: number}}
 */
function sheetsToState(sheets) {
  const { nodes: nodesSheet, connections: linksSheet } = findInventorySheets(sheets);
  const nodes = {};
  const edges = [];
  const idByLabel = new Map();

  if (nodesSheet) {
    // Skip disclaimer row and blank row: find the header row (contains label/type).
    let dataStart = 0;
    for (let i = 0; i < nodesSheet.rows.length; i++) {
      const keys = nodesSheet.rows[i].map(displayKey);
      if (keys.includes("label") || keys.includes("etiquette")) { dataStart = i + 1; break; }
    }
    let seq = 0;
    for (let i = dataStart; i < nodesSheet.rows.length; i++) {
      const r = nodesSheet.rows[i];
      if (!r || r.every((c) => String(c).trim() === "")) continue;
      const id = `n${++seq}`;
      nodes[id] = { type: mapTypeDisplay(r[1] || ""), x: 0, y: 0, label: String(r[0] || "") };
      if (!idByLabel.has(String(r[0] || ""))) idByLabel.set(String(r[0] || ""), id);
    }
  }
  if (linksSheet) {
    let dataStart = 0;
    for (let i = 0; i < linksSheet.rows.length; i++) {
      const keys = linksSheet.rows[i].map(displayKey);
      if ((keys.includes("from") || keys.includes("de")) &&
          (keys.includes("to") || keys.includes("vers"))) { dataStart = i + 1; break; }
    }
    for (let i = dataStart; i < linksSheet.rows.length; i++) {
      const r = linksSheet.rows[i];
      if (!r || r.every((c) => String(c).trim() === "")) continue;
      const a = idByLabel.get(String(r[0] || ""));
      const b = idByLabel.get(String(r[1] || ""));
      if (!a || !b) continue;
      edges.push({ a, b, cat: mapCategoryDisplay(r[2] || "") });
    }
  }
  return { nodes, edges, seq: Object.keys(nodes).length };
}

module.exports = {
  parseSpreadsheetML,
  findInventorySheets,
  buildSpreadsheetML,
  sheetsToState,
  mapTypeDisplay,
  mapCategoryDisplay,
};

});
var __api = {};
__api["mapColumns"] = __require("column-mapper")["mapColumns"];
__api["splitSections"] = __require("column-mapper")["splitSections"];
__api["findHeaderRow"] = __require("column-mapper")["findHeaderRow"];
__api["normalizeHeader"] = __require("column-mapper")["normalizeHeader"];
__api["COLUMN_SETS"] = __require("column-mapper")["COLUMN_SETS"];
__api["proposeCategory"] = __require("edge-categorizer")["proposeCategory"];
__api["validate"] = __require("validate")["validate"];
__api["normalizeName"] = __require("validate")["normalizeName"];
__api["toCanonicalModel"] = __require("canonical-model")["toCanonicalModel"];
__api["normalizeType"] = __require("canonical-model")["normalizeType"];
__api["normalizeCategoryEnum"] = __require("canonical-model")["normalizeCategoryEnum"];
__api["buildState"] = __require("state-builder")["buildState"];
__api["LAYOUT"] = __require("state-builder")["LAYOUT"];
__api["parseSpreadsheetML"] = __require("spreadsheetml-parser")["parseSpreadsheetML"];
__api["findInventorySheets"] = __require("spreadsheetml-parser")["findInventorySheets"];
__api["buildSpreadsheetML"] = __require("spreadsheetml-parser")["buildSpreadsheetML"];
__api["sheetsToState"] = __require("spreadsheetml-parser")["sheetsToState"];
__api["mapTypeDisplay"] = __require("spreadsheetml-parser")["mapTypeDisplay"];
__api["mapCategoryDisplay"] = __require("spreadsheetml-parser")["mapCategoryDisplay"];
window.DMEngine = __api;
})();
