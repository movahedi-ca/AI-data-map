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
