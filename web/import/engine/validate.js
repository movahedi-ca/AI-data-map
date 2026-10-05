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
