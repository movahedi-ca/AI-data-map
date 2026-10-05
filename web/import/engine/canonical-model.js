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
