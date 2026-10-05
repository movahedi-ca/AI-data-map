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
