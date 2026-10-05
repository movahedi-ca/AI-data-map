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
