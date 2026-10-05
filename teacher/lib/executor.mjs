// executor.mjs
// Deterministic, scripted executor for Phase 0 data-mapping recipes.
// Implements the 12 actions in action-catalogue.json against the frozen
// guide model, with idempotency keys, a monotonic guide seq, flag gating,
// undo with tombstones, termination sealing, and the 32-slot actions
// window with the iterative prefix hash chain.
//
// Design notes worth knowing:
// - validMenu() is a closed deterministic function of (recipe item,
//   session state), per token-schema.json menu_grounding. apply() rejects
//   any action name not present in the current menu.
// - Intent actions (the current recipe item's intent) execute only with
//   the exact params from the recipe; anything else is rejected loudly.
// - flag_for_review is mutating, so undo_last targeting it clears the
//   flag. That is the documented in-band clear mechanism: there is no
//   separate clear_flag action. A human can also clear flags out of band
//   through the review UI; the executor simply observes that the flag
//   annotation is gone.
// - undo_last actions are recorded under their own idempotency keys but
//   are skipped when scanning for the next undo target, so a second
//   consecutive undo_last undoes the next-earlier mutating action.
// - Tombstones live in executor memory only. They are not part of the
//   serialized snapshot because state_hash covers {nodes, edges,
//   annotations} only; a rebuilt executor re-derives them by replaying
//   the shard in order.

import { createHash } from "node:crypto";
import { validateRecipe } from "./validate.mjs";

const SNAPSHOT_VERSION = "1.0.0";
const WINDOW_N = 32;
const H0 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MAX_NODES = 64;
const MAX_EDGES = 64;
const MAX_PARAMS_BYTES = 4096;
const NODE_ID_RE = /^n[1-9]\d*$/;
const NODE_TYPES = ["collection", "system", "thirdparty", "destruction"];
const EDGE_CATS = ["contact", "payment", "marketing"];
const EDGE_CAT_ORDER = { contact: 0, marketing: 1, payment: 2 };
const CHECK_NAMES = ["label_coverage", "connectivity", "retention_cited", "edge_categories"];
// Non-mutating actions per action-catalogue.json (explicit "mutating": false).
// Everything else defaults to mutating: true.
const NON_MUTATING = new Set(["confirm_node", "run_check", "export", "skip_recipe_item", "abort_session"]);
const LAW25_VARIANTS = [
  "law 25",
  "loi 25",
  "bill 64",
  "lprpsp",
  "modernisant des dispositions legislatives en matiere de protection des renseignements personnels",
  "renseignements personnels dans le secteur prive",
];
// Normative section matcher from the catalogue: act plus section, e.g.
// "s. 230(4)(b)", "ss. 34, 35.3", "art. 23". A bare act name never matches.
const SECTION_RE = /([Ss][Ss]?\.?\s*[0-9]+|[Aa][Rr][Tt]\.?\s*[0-9]+|[Aa][Rr][Tt][Ii][Cc][Ll][Ee]\s+[0-9]+|[Rr]\.?\s*[0-9]+(\.[0-9]+)*|§\s*[0-9]+)/;

// Normative statute matcher from action-catalogue.json. Returns null when
// the statute is acceptable, else a plain-language rejection reason.
// Case-insensitive: the input is normalized to lowercase first.
export function sha256hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function checkStatute(statute) {
  if (typeof statute !== "string" || statute.length < 8) {
    return "statute must be a string of at least 8 characters.";
  }
  const lowered = statute.toLowerCase();
  const hit = LAW25_VARIANTS.find((v) => lowered.includes(v));
  if (hit) {
    return `the statute cites "${hit}", and Law 25 sets no retention periods; ` +
      `it can never be the source of a number.`;
  }
  if (!SECTION_RE.test(statute)) {
    return `the statute must name both the act and the section ` +
      `(for example "s. 230(4)(b)" or "art. 23"); "${statute}" has no section.`;
  }
  return null;
}

// Canonical JSON: object keys sorted ascending in UTF-8 byte order,
// arrays in their given order, no whitespace. Numbers serialize plain;
// callers round coordinates before hashing.
export function canon(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "[" + value.map(canon).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).sort((a, b) =>
      Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canon(value[k])).join(",") + "}";
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot canonicalize non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  throw new Error("cannot canonicalize value of type " + typeof value);
}

function deepCopy(v) {
  return JSON.parse(JSON.stringify(v));
}

// Round half up, for guide coordinates before hashing.
function roundHalfUp(n) {
  return Math.floor(n + 0.5);
}

function nodeNum(id) {
  return parseInt(id.slice(1), 10);
}

function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

export class Executor {
  constructor(recipe, specsDir) {
    if (!recipe || typeof recipe !== "object") {
      throw new Error("recipe load rejected: the recipe must be an object.");
    }
    const check = validateRecipe(recipe, specsDir);
    if (!check.ok) {
      const first = check.errors[0];
      throw new Error(
        `recipe load rejected: invalid recipe (schema_version ${recipe.schema_version || "missing"}): ` +
        `${first.path ? "at " + first.path + ": " : ""}${first.message}`);
    }
    if (!/^1\.0\.\d+$/.test(recipe.schema_version || "")) {
      throw new Error(
        `recipe load rejected: recipe schema_version "${recipe.schema_version}" is not supported by ` +
        `executor 1.x, which supports recipe 1.0.x. The recipe is not executed at all.`);
    }
    for (let i = 0; i < recipe.items.length; i++) {
      const bytes = Buffer.byteLength(canon(recipe.items[i].params), "utf8");
      if (bytes > MAX_PARAMS_BYTES) {
        throw new Error(
          `recipe load rejected: item ${i} params serialize to ${bytes} bytes, over the 4096-byte limit.`);
      }
    }
    this._recipe = deepCopy(recipe);
    this._recipeId = recipe.recipe_id;
    this._items = this._recipe.items;
    this._seq = 0;               // guide seq: monotonic, never decrements
    this._nodes = {};            // node_id -> {type, x, y, label}
    this._edges = [];            // [{a, b, cat}]
    this._annotations = [];      // [{kind, node_id, payload}]
    this._appliedKeys = {};      // idempotency key -> {action_record, result}
    this._actions = [];          // last WINDOW_N action records, oldest first
    this._droppedCount = 0;
    this._prefixHash = H0;
    this._itemIndex = 0;
    this._terminated = false;
    this._abortReason = null;
    this._tombstones = new Set();
    this._history = [];          // applied mutating actions with inverse data
    this._done = new Set();      // completed item indices (executed or skipped)
    this._skipped = new Set();   // skipped item indices
  }

  _key(actionName, itemIndex) {
    return sha256hex(this._recipeId + "\0" + itemIndex + "\0" + actionName);
  }

  _flagOpen() {
    return this._annotations.some((a) => a.kind === "review_flag");
  }

  // The most recent applied mutating action that undo_last could reverse,
  // or null. undo_last records themselves are skipped.
  _undoTarget() {
    for (let i = this._history.length - 1; i >= 0; i--) {
      const h = this._history[i];
      if (!h.undone && h.name !== "undo_last") return h;
    }
    return null;
  }

  _undoable() {
    return this._undoTarget() !== null;
  }

  // The valid-action menu: a closed deterministic function of the current
  // recipe item and session state. At most 5 entries, alphabetical by name.
  validMenu() {
    const menu = [];
    const flagOpen = this._flagOpen();
    if (!flagOpen && this._itemIndex < this._items.length) {
      const item = this._items[this._itemIndex];
      menu.push({ action_name: item.intent, params: deepCopy(item.params) });
      menu.push({ action_name: "skip_recipe_item", params: { item_index: this._itemIndex } });
    }
    if (this._undoable()) menu.push({ action_name: "undo_last", params: {} });
    // flag_for_review is unparameterized in the menu; it targets the
    // current item by default when no node_id/item_index is supplied.
    menu.push({ action_name: "flag_for_review", params: {} });
    menu.push({ action_name: "abort_session", params: {} });
    menu.sort((a, b) => (a.action_name < b.action_name ? -1 : a.action_name > b.action_name ? 1 : 0));
    return menu;
  }

  // SHA-256 hex over the canonical serialization of {nodes, edges,
  // annotations} taken right now.
  stateHash() {
    const nodes = Object.keys(this._nodes)
      .sort((a, b) => nodeNum(a) - nodeNum(b))
      .map((id) => {
        const n = this._nodes[id];
        return { id, label: n.label, type: n.type, x: roundHalfUp(n.x), y: roundHalfUp(n.y) };
      });
    const edges = this._edges
      .map((e) => ({ a: e.a, b: e.b, cat: e.cat }))
      .sort((p, q) =>
        nodeNum(p.a) - nodeNum(q.a) ||
        nodeNum(p.b) - nodeNum(q.b) ||
        EDGE_CAT_ORDER[p.cat] - EDGE_CAT_ORDER[q.cat]);
    const annotations = this._annotations
      .map((a) => ({ kind: a.kind, node_id: a.node_id, payload: deepCopy(a.payload) }))
      .sort((p, q) =>
        nodeNum(p.node_id) - nodeNum(q.node_id) ||
        (p.kind < q.kind ? -1 : p.kind > q.kind ? 1 : 0) ||
        Buffer.compare(Buffer.from(canon(p.payload), "utf8"), Buffer.from(canon(q.payload), "utf8")));
    return sha256hex(canon({ nodes, edges, annotations }));
  }

  snapshot() {
    return {
      snapshot_version: SNAPSHOT_VERSION,
      recipe_id: this._recipeId,
      item_index: this._itemIndex,
      canvas: {
        nodes: deepCopy(this._nodes),
        edges: deepCopy(this._edges),
      },
      annotations: deepCopy(this._annotations),
      applied_keys: deepCopy(this._appliedKeys),
      actions: deepCopy(this._actions),
      dropped_prefix: { count: this._droppedCount, prefix_hash: this._prefixHash },
      terminated: this._terminated,
      abort_reason: this._abortReason,
    };
  }

  _pushRecord(record) {
    this._actions.push(record);
    while (this._actions.length > WINDOW_N) {
      const dropped = this._actions.shift();
      this._droppedCount += 1;
      // H(k+1) = SHA-256 hex of the ASCII bytes of H(k) + dropped state_hash.
      this._prefixHash = sha256hex(this._prefixHash + dropped.state_hash);
    }
  }

  apply(actionName, params) {
    const p = params === undefined || params === null ? {} : params;
    const itemIndex = this._itemIndex;
    const key = this._key(actionName, itemIndex);
    if (this._tombstones.has(key)) {
      throw new Error(
        `replay rejected: ${actionName} at item ${itemIndex} was undone and its key is tombstoned; ` +
        `a stale replay cannot resurrect it.`);
    }
    const recorded = this._appliedKeys[key];
    if (recorded) {
      // Idempotent replay: return the recorded result, do no work.
      return { action_record: recorded.action_record, snapshot: this.snapshot() };
    }
    if (this._terminated) {
      throw new Error(
        `rejected: the session was terminated (reason: ${this._abortReason}); ` +
        `a terminated session never resumes.`);
    }
    const entry = this.validMenu().find((e) => e.action_name === actionName);
    if (!entry) {
      const why = this._flagOpen()
        ? "a review flag is open, so only undo_last, flag_for_review, and abort_session are allowed"
        : (this._itemIndex >= this._items.length
          ? "the recipe is complete; only recovery actions remain"
          : `the current item is "${this._items[this._itemIndex].intent}"`);
      throw new Error(`rejected: "${actionName}" is not in the valid-action menu at item ${itemIndex} (${why}).`);
    }

    const done = this._execute(actionName, p, itemIndex);
    const stateHash = this.stateHash();
    const action_record = {
      action_id: `${actionName}:${itemIndex}`,
      params: deepCopy(p),
      state_hash: stateHash,
    };
    this._pushRecord(action_record);
    this._appliedKeys[key] = { action_record: deepCopy(action_record), result: deepCopy(done.result) };
    if (done.mutating) {
      this._history.push({ key, name: actionName, item_index: itemIndex, inverse: done.inverse, undone: false });
    }
    if (actionName === "skip_recipe_item") {
      this._skipped.add(itemIndex);
      this._done.add(itemIndex);
      this._itemIndex += 1;
    } else if (actionName === "abort_session") {
      this._terminated = true;
      this._abortReason = p.reason;
    } else if (this._itemIndex < this._items.length && actionName === this._items[this._itemIndex].intent) {
      // The current recipe item's intent completed: advance past it.
      this._done.add(itemIndex);
      this._itemIndex += 1;
    }
    return { action_record, snapshot: this.snapshot() };
  }

  _execute(actionName, p, itemIndex) {
    switch (actionName) {
      case "add_node": return this._doAddNode(p, false);
      case "add_collection_point": return this._doAddNode(p, true);
      case "connect": return this._doConnect(p);
      case "set_field": return this._doSetField(p);
      case "set_retention": return this._doSetRetention(p);
      case "confirm_node": return this._doConfirmNode(p, itemIndex);
      case "flag_for_review": return this._doFlag(p, itemIndex);
      case "run_check": return this._doRunCheck(p);
      case "export": return this._doExport(p);
      case "skip_recipe_item": return this._doSkip(p, itemIndex);
      case "undo_last": return this._doUndo(itemIndex);
      case "abort_session": return this._doAbort(p);
      default: throw new Error(`rejected: unknown action "${actionName}".`);
    }
  }

  // Intent actions execute only with the exact params from the recipe.
  _checkIntentParams(actionName, p, itemIndex) {
    const item = this._items[itemIndex];
    if (!item || item.intent !== actionName) {
      throw new Error(`rejected: "${actionName}" is not the current recipe item's intent.`);
    }
    if (canon(p) !== canon(item.params)) {
      throw new Error(
        `rejected: "${actionName}" params do not match the recipe item ${itemIndex} params exactly.`);
    }
  }

  _requireNode(node_id, actionName) {
    if (!NODE_ID_RE.test(node_id || "") || !this._nodes[node_id]) {
      throw new Error(`${actionName} rejected: node "${node_id}" does not exist.`);
    }
  }

  _doAddNode(p, collectionPoint) {
    const actionName = collectionPoint ? "add_collection_point" : "add_node";
    this._checkIntentParams(actionName, p, this._itemIndex);
    const expected = "n" + (this._seq + 1);
    if (p.node_id !== expected) {
      throw new Error(
        `${actionName} rejected: node_id "${p.node_id}" is out of sequence; the guide seq is ` +
        `${this._seq}, so the next node id must be "${expected}".`);
    }
    const type = collectionPoint ? "collection" : p.type;
    if (!collectionPoint && !NODE_TYPES.includes(p.type)) {
      throw new Error(`${actionName} rejected: unknown node type "${p.type}".`);
    }
    for (const [k, lo, hi] of [["x", 40, 600], ["y", 40, 380]]) {
      if (typeof p[k] !== "number" || !Number.isFinite(p[k]) || p[k] < lo || p[k] > hi) {
        throw new Error(`${actionName} rejected: ${k} must be a number in [${lo}, ${hi}]; got ${JSON.stringify(p[k])}.`);
      }
    }
    if (typeof p.label !== "string" || p.label.length < 1 || p.label.length > 200) {
      throw new Error(`${actionName} rejected: label must be 1-200 characters.`);
    }
    if (Object.keys(this._nodes).length >= MAX_NODES) {
      throw new Error(`${actionName} rejected: the canvas already holds ${MAX_NODES} nodes (the frozen limit).`);
    }
    this._nodes[p.node_id] = { type, x: p.x, y: p.y, label: p.label };
    this._seq += 1; // monotonic: never decrements, even after undo
    return {
      mutating: true,
      result: { node_id: p.node_id, type, seq: this._seq },
      inverse: { op: "delete_node", node_id: p.node_id },
    };
  }

  _doConnect(p) {
    this._checkIntentParams("connect", p, this._itemIndex);
    this._requireNode(p.a, "connect");
    this._requireNode(p.b, "connect");
    if (p.a === p.b) throw new Error(`connect rejected: self-loops are not allowed (${p.a} to itself).`);
    if (!EDGE_CATS.includes(p.cat)) throw new Error(`connect rejected: unknown edge category "${p.cat}".`);
    const dup = this._edges.some((e) =>
      (e.a === p.a && e.b === p.b) || (e.a === p.b && e.b === p.a));
    if (dup) throw new Error(`connect rejected: ${p.a} and ${p.b} are already connected in one direction.`);
    if (this._edges.length >= MAX_EDGES) {
      throw new Error(`connect rejected: the canvas already holds ${MAX_EDGES} edges (the frozen limit).`);
    }
    this._edges.push({ a: p.a, b: p.b, cat: p.cat });
    return {
      mutating: true,
      result: { a: p.a, b: p.b, cat: p.cat },
      inverse: { op: "remove_edge", a: p.a, b: p.b, cat: p.cat },
    };
  }

  _doSetField(p) {
    this._checkIntentParams("set_field", p, this._itemIndex);
    this._requireNode(p.node_id, "set_field");
    if (!["label", "x", "y"].includes(p.field)) {
      throw new Error(`set_field rejected: unknown field "${p.field}"; only label, x, y are writable.`);
    }
    const node = this._nodes[p.node_id];
    const oldValue = node[p.field];
    if (p.field === "label") {
      if (typeof p.value !== "string" || p.value.length < 1 || p.value.length > 200) {
        throw new Error(`set_field rejected: label must be a string of 1-200 characters.`);
      }
    } else {
      const [lo, hi] = p.field === "x" ? [40, 600] : [40, 380];
      if (typeof p.value !== "number" || !Number.isFinite(p.value) || p.value < lo || p.value > hi) {
        throw new Error(
          `set_field rejected: ${p.field} must be a number in [${lo}, ${hi}] (out-of-range values are ` +
          `rejected, never clamped); got ${JSON.stringify(p.value)}.`);
      }
    }
    node[p.field] = p.value;
    return {
      mutating: true,
      result: { node_id: p.node_id, field: p.field, old_value: oldValue, new_value: p.value },
      inverse: { op: "restore_field", node_id: p.node_id, field: p.field, old_value: oldValue },
    };
  }

  _doSetRetention(p) {
    this._checkIntentParams("set_retention", p, this._itemIndex);
    this._requireNode(p.node_id, "set_retention");
    if (typeof p.as_of !== "string" || !isRealDate(p.as_of)) {
      throw new Error(`set_retention rejected: as_of must be a real calendar date in YYYY-MM-DD form.`);
    }
    if (p.as_of > todayUtc()) {
      throw new Error(`set_retention rejected: as_of "${p.as_of}" is in the future.`);
    }
    if (typeof p.record_type !== "string" || p.record_type.length < 1 || p.record_type.length > 120) {
      throw new Error(`set_retention rejected: record_type must be 1-120 characters.`);
    }
    const verifyOnly = p.verify_only === true;
    let payload;
    if (verifyOnly) {
      payload = { record_type: p.record_type, verify_only: true, as_of: p.as_of };
    } else {
      for (const k of ["range_min_years", "range_max_years"]) {
        if (typeof p[k] !== "number" || !Number.isFinite(p[k]) || p[k] <= 0) {
          throw new Error(`set_retention rejected: ${k} must be a number greater than 0.`);
        }
      }
      if (!(p.range_min_years < p.range_max_years)) {
        throw new Error(
          `set_retention rejected: range_min_years (${p.range_min_years}) must be strictly less than ` +
          `range_max_years (${p.range_max_years}); a single number is never accepted.`);
      }
      const statuteProblem = checkStatute(p.statute);
      if (statuteProblem) {
        throw new Error(`set_retention rejected: ${statuteProblem}`);
      }
      payload = {
        record_type: p.record_type,
        range_min_years: p.range_min_years,
        range_max_years: p.range_max_years,
        statute: p.statute,
        as_of: p.as_of,
      };
    }
    if (typeof p.anchor === "string") {
      if (p.anchor.length > 120) throw new Error(`set_retention rejected: anchor must be at most 120 characters.`);
      if (p.anchor.length > 0) payload.anchor = p.anchor;
    }
    const prevIdx = this._annotations.findIndex(
      (a) => a.kind === "retention" && a.node_id === p.node_id);
    const previous = prevIdx >= 0 ? this._annotations[prevIdx] : null;
    if (prevIdx >= 0) this._annotations.splice(prevIdx, 1);
    const annotation = { kind: "retention", node_id: p.node_id, payload };
    this._annotations.push(annotation);
    return {
      mutating: true,
      result: { node_id: p.node_id, replaced: previous !== null },
      inverse: { op: "restore_retention", node_id: p.node_id, annotation, previous },
    };
  }

  _doConfirmNode(p, itemIndex) {
    this._checkIntentParams("confirm_node", p, this._itemIndex);
    this._requireNode(p.node_id, "confirm_node");
    if (p.note !== undefined && (typeof p.note !== "string" || p.note.length > 500)) {
      throw new Error(`confirm_node rejected: note must be a string of at most 500 characters.`);
    }
    this._annotations.push({
      kind: "confirmation",
      node_id: p.node_id,
      payload: { note: p.note === undefined ? "" : p.note, item_index: itemIndex },
    });
    return { mutating: false, result: { node_id: p.node_id, item_index: itemIndex }, inverse: null };
  }

  _doFlag(p, itemIndex) {
    const nodeId = p.node_id;
    let flagItem = p.item_index;
    if (nodeId === undefined && flagItem === undefined) {
      // The menu entry is unparameterized: it targets the current item.
      flagItem = itemIndex;
    }
    if (nodeId !== undefined) this._requireNode(nodeId, "flag_for_review");
    if (flagItem !== undefined && (!Number.isInteger(flagItem) || flagItem < 0 || flagItem >= this._items.length)) {
      throw new Error(`flag_for_review rejected: item_index ${flagItem} does not reference a recipe item.`);
    }
    if (nodeId === undefined && flagItem === undefined) {
      throw new Error(`flag_for_review rejected: at least one of node_id or item_index is required.`);
    }
    if (typeof p.reason !== "string" || p.reason.length < 1 || p.reason.length > 500) {
      throw new Error(`flag_for_review rejected: reason must be 1-500 characters.`);
    }
    const payload = { reason: p.reason, item_index: flagItem === undefined ? null : flagItem };
    if (nodeId !== undefined) payload.node_id = nodeId;
    // Review flags attach to a node for the (node_id, kind) annotation
    // ordering. When only an item is under review, anchor on the first
    // node on the canvas. When the canvas is empty (e.g. flagging the
    // very first item before anything is built), anchor on the id the
    // next built node will take: "n" + (seq + 1). The catalogue allows
    // item-only flags, and the snapshot schema requires a node_id on
    // every annotation, so this anchor keeps the trace schema-valid and
    // deterministic without inventing canvas state. Teacher encoding
    // rule for this spec corner; the frozen specs do not pin it down.
    let anchor = nodeId;
    if (anchor === undefined) {
      anchor = Object.keys(this._nodes).sort((a, b) => nodeNum(a) - nodeNum(b))[0];
      if (!anchor) anchor = "n" + (this._seq + 1);
    }
    const annotation = { kind: "review_flag", node_id: anchor, payload };
    this._annotations.push(annotation);
    return {
      mutating: true,
      result: { flag_open: true, open_flags: this._annotations.filter((a) => a.kind === "review_flag").length },
      inverse: { op: "clear_flag", annotation },
    };
  }

  _doRunCheck(p) {
    this._checkIntentParams("run_check", p, this._itemIndex);
    if (!Array.isArray(p.checks) || p.checks.length < 1) {
      throw new Error(`run_check rejected: checks must be a non-empty array.`);
    }
    if (new Set(p.checks).size !== p.checks.length) {
      throw new Error(`run_check rejected: checks must be unique.`);
    }
    for (const c of p.checks) {
      if (!CHECK_NAMES.includes(c)) throw new Error(`run_check rejected: unknown check "${c}".`);
    }
    const ids = Object.keys(this._nodes).sort((a, b) => nodeNum(a) - nodeNum(b));
    const report = {};
    if (p.checks.includes("label_coverage")) {
      const missing = ids.filter((id) => {
        const l = this._nodes[id].label;
        return !l || l.toLowerCase() === "untitled";
      });
      report.label_coverage = {
        pass: missing.length === 0,
        findings: missing.map((id) => `node ${id} has no usable label`),
      };
    }
    if (p.checks.includes("connectivity")) {
      const findings = [];
      const touches = (id, wantSystem) => this._edges.some((e) => {
        const other = e.a === id ? e.b : e.b === id ? e.a : null;
        if (other === null) return false;
        return wantSystem ? this._nodes[other].type === "system" : true;
      });
      for (const id of ids) {
        const t = this._nodes[id].type;
        if (t === "destruction") continue;
        if (t === "collection" && !touches(id, true)) {
          findings.push(`collection node ${id} has no edge to a system node`);
        } else if (t !== "collection" && !touches(id, false)) {
          findings.push(`node ${id} participates in no edge`);
        }
      }
      report.connectivity = { pass: findings.length === 0, findings };
    }
    if (p.checks.includes("retention_cited")) {
      const findings = [];
      for (const id of ids) {
        const t = this._nodes[id].type;
        if (t !== "system" && t !== "thirdparty") continue;
        const ann = this._annotations.find((a) => a.kind === "retention" && a.node_id === id);
        const cited = ann && (ann.payload.verify_only === true || typeof ann.payload.range_max_years === "number");
        if (!cited) findings.push(`node ${id} (${t}) has no retention citation`);
      }
      report.retention_cited = { pass: findings.length === 0, findings };
    }
    if (p.checks.includes("edge_categories")) {
      const bad = this._edges.filter((e) => !EDGE_CATS.includes(e.cat));
      report.edge_categories = {
        pass: bad.length === 0,
        findings: bad.map((e) => `edge ${e.a}->${e.b} has unknown category ${e.cat}`),
      };
    }
    return { mutating: false, result: { report }, inverse: null };
  }

  _doExport(p) {
    this._checkIntentParams("export", p, this._itemIndex);
    if (p.format !== "xls") {
      throw new Error(`export rejected: format must be "xls"; got ${JSON.stringify(p.format)}.`);
    }
    if (Object.keys(this._nodes).length < 1) {
      throw new Error(`export rejected: the canvas is empty.`);
    }
    return {
      mutating: false,
      result: {
        downloaded: "data-map-inventory.xls",
        nodes: Object.keys(this._nodes).length,
        edges: this._edges.length,
      },
      inverse: null,
    };
  }

  _doSkip(p, itemIndex) {
    if (!Number.isInteger(p.item_index) || p.item_index !== itemIndex) {
      throw new Error(
        `skip_recipe_item rejected: item_index must equal the current item_index (${itemIndex}); ` +
        `only the current item may be skipped.`);
    }
    if (itemIndex >= this._items.length) {
      throw new Error(`skip_recipe_item rejected: there is no current item left to skip.`);
    }
    if (this._done.has(itemIndex)) {
      throw new Error(`skip_recipe_item rejected: item ${itemIndex} already completed successfully.`);
    }
    if (typeof p.reason !== "string" || p.reason.length < 1 || p.reason.length > 200) {
      throw new Error(`skip_recipe_item rejected: reason must be 1-200 characters.`);
    }
    return { mutating: false, result: { skipped_item: itemIndex, reason: p.reason }, inverse: null };
  }

  _doUndo() {
    const target = this._undoTarget();
    if (!target) {
      throw new Error(`undo_last rejected: no applied mutating action is left to undo.`);
    }
    this._applyInverse(target.inverse);
    target.undone = true;
    this._tombstones.add(target.key);
    return {
      mutating: true,
      result: {
        undone_action: target.name,
        undone_action_id: `${target.name}:${target.item_index}`,
        tombstoned_key: target.key,
      },
      inverse: null, // no re-apply in Phase 0
    };
  }

  _applyInverse(inv) {
    if (!inv) return;
    switch (inv.op) {
      case "delete_node": {
        delete this._nodes[inv.node_id];
        this._edges = this._edges.filter((e) => e.a !== inv.node_id && e.b !== inv.node_id);
        // The guide seq stays put: undone ids leave gaps, by design.
        break;
      }
      case "remove_edge": {
        const i = this._edges.findIndex((e) => e.a === inv.a && e.b === inv.b && e.cat === inv.cat);
        if (i >= 0) this._edges.splice(i, 1);
        break;
      }
      case "restore_field": {
        if (this._nodes[inv.node_id]) this._nodes[inv.node_id][inv.field] = inv.old_value;
        break;
      }
      case "restore_retention": {
        const i = this._annotations.indexOf(inv.annotation);
        if (i >= 0) this._annotations.splice(i, 1);
        if (inv.previous) this._annotations.push(inv.previous);
        break;
      }
      case "clear_flag": {
        const i = this._annotations.indexOf(inv.annotation);
        if (i >= 0) this._annotations.splice(i, 1);
        break;
      }
      default:
        throw new Error(`internal error: unknown undo op "${inv.op}".`);
    }
  }

  _doAbort(p) {
    if (typeof p.reason !== "string" || p.reason.length < 1 || p.reason.length > 500) {
      throw new Error(`abort_session rejected: reason must be 1-500 characters.`);
    }
    return { mutating: false, result: { terminated: true, reason: p.reason }, inverse: null };
  }
}
