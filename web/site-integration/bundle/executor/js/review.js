/**
 * review.js - review-loop derivation for the System-1 executor UI.
 *
 * Per the executor domain contract (section 6):
 *  - deriveChecklist: one row per artifact (nodes in node-id numeric order,
 *    then edges in (a, b, cat) order, then retention annotations), matching
 *    the token ordering so the step log, the checklist, and the model input
 *    walk the same sequence. Rows covered by confirm_node items in the
 *    recipe start as confirmed; all others start unconfirmed.
 *  - confirmation records in the contract's 6.2 format (by: "reviewer").
 *  - corrections logged as structured JSON lines for future training.
 *
 * Depends on s1util.js. UMD: browsers and Node. No em dashes.
 */
(function (root, factory) {
  "use strict";
  var api = factory(root.S1Util);
  if (typeof module === "object" && module !== null && typeof module.exports === "object") {
    module.exports = api;
  } else {
    root.S1Review = api;
  }
})(typeof self !== "undefined" ? self : this, function (U) {
  "use strict";

  if (!U) throw new Error("review.js requires s1util.js (S1Util) to load first.");

  function labelOf(nodes, id) {
    return (nodes[id] && nodes[id].label) || id;
  }

  /**
   * Derive the checklist from the executed recipe and session state.
   * @param {object} ex the Executor instance.
   * @returns {Array} rows: {ref, kind, label, detail, status}
   */
  function deriveChecklist(ex) {
    var rows = [];
    var nodeIds = Object.keys(ex._nodes).sort(function (a, b) { return U.nodeNum(a) - U.nodeNum(b); });
    var confirmedNodes = {};
    ex._items.forEach(function (item) {
      if (item.intent === "confirm_node" && item.params && item.params.node_id) {
        confirmedNodes[item.params.node_id] = true;
      }
    });
    nodeIds.forEach(function (id) {
      var n = ex._nodes[id];
      rows.push({
        ref: "node:" + id,
        kind: "node",
        node_id: id,
        label: n.label,
        detail: { type: n.type, x: U.roundHalfUp(n.x), y: U.roundHalfUp(n.y), meta: U.deepCopy(n.meta || {}) },
        status: confirmedNodes[id] ? "confirmed" : "unconfirmed"
      });
    });
    var edges = ex._edges.slice().sort(function (p, q) {
      return U.nodeNum(p.a) - U.nodeNum(q.a) ||
        U.nodeNum(p.b) - U.nodeNum(q.b) ||
        U.EDGE_CAT_ORDER[p.cat] - U.EDGE_CAT_ORDER[q.cat];
    });
    edges.forEach(function (e) {
      rows.push({
        ref: "edge:" + e.a + "->" + e.b,
        kind: "edge",
        a: e.a, b: e.b, cat: e.cat,
        label: labelOf(ex._nodes, e.a) + " -> " + labelOf(ex._nodes, e.b),
        detail: { cat: e.cat, meta: U.deepCopy(e.meta || {}) },
        status: "unconfirmed"
      });
    });
    var retentions = ex._annotations.filter(function (a) { return a.kind === "retention"; });
    retentions.sort(function (p, q) { return U.nodeNum(p.node_id) - U.nodeNum(q.node_id); });
    retentions.forEach(function (a) {
      var pl = a.payload;
      rows.push({
        ref: "retention:" + a.node_id,
        kind: "retention",
        node_id: a.node_id,
        label: labelOf(ex._nodes, a.node_id),
        detail: {
          record_type: pl.record_type,
          range: pl.verify_only === true ? "verify" : (pl.range_min_years + " to " + pl.range_max_years + " years"),
          statute: pl.verify_only === true ? null : (pl.statute || null),
          as_of: pl.as_of,
          anchor: pl.anchor || null
        },
        status: "unconfirmed"
      });
    });
    return rows;
  }

  function utcNow() {
    return new Date().toISOString();
  }

  /**
   * Build a confirmation record (domain contract 6.2).
   */
  function confirmationRecord(sessionId, recipeId, itemIndex, ref, label, note) {
    return {
      session_id: sessionId,
      recipe_id: recipeId,
      item_index: itemIndex,
      ref: ref,
      label: label,
      note: (note === undefined || note === null) ? "" : String(note).slice(0, 500),
      by: "reviewer",
      at: utcNow()
    };
  }

  /**
   * Build a correction JSONL line for future training.
   */
  function correctionLine(sessionId, recipeId, op, ref, before, after) {
    return {
      session_id: sessionId,
      recipe_id: recipeId,
      at: utcNow(),
      op: op,
      ref: ref,
      before: before === undefined ? null : before,
      after: after === undefined ? null : after
    };
  }

  return {
    deriveChecklist: deriveChecklist,
    confirmationRecord: confirmationRecord,
    correctionLine: correctionLine,
    utcNow: utcNow
  };
});
