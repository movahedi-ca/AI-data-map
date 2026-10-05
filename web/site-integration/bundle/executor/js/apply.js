/**
 * apply.js - Executor port for the System-1 in-browser executor.
 *
 * Faithful browser port of teacher/lib/executor.mjs (Executor class):
 * idempotency keys, monotonic guide seq, flag gating, undo with tombstones,
 * termination sealing, the 32-slot actions window with the iterative prefix
 * hash chain, stateHash, snapshot, and the twelve _do* action handlers.
 *
 * Node-only pieces replaced: node:crypto -> S1Util.sha256Hex, Buffer.compare
 * -> S1Util.compareUtf8Bytes, validate.mjs (shells to python) -> a structural
 * browser-side check (templates are validated against the real JSON schema at
 * authoring time by the build gate, not in the browser).
 *
 * UI-layer extensions, marked below, support the review loop: the review UI
 * may touch the session layer out-of-band (the same out-of-band rule the
 * teacher documents for flag clearing).
 *
 * UMD: runs in browsers and Node. No network, no storage, no em dashes.
 */
(function (root, factory) {
  "use strict";
  var api = factory(root.S1Util, root.S1Menu);
  if (typeof module === "object" && module !== null && typeof module.exports === "object") {
    module.exports = api;
  } else {
    root.S1Apply = api;
  }
})(typeof self !== "undefined" ? self : this, function (U, M) {
  "use strict";

  if (!U) throw new Error("apply.js requires s1util.js (S1Util) to load first.");
  if (!M) throw new Error("apply.js requires menu.js (S1Menu) to load first.");

  var SNAPSHOT_VERSION = "1.0.0";
  var EXECUTOR_VERSION = "1.0.0";
  var WINDOW_N = 32;
  var H0 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  /* Structural recipe check for the browser. The full JSON-schema validation
     runs at template authoring time (build gate); this rejects anything
     structurally unsound before the first item runs. */
  function checkRecipe(recipe) {
    if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
      throw new Error("recipe load rejected: the recipe must be an object.");
    }
    if (!U.RECIPE_ID_RE.test(recipe.recipe_id || "")) {
      throw new Error("recipe load rejected: recipe_id must match ^[A-Za-z0-9_-]+$.");
    }
    if (!/^1\.0\.\d+$/.test(recipe.schema_version || "")) {
      throw new Error(
        "recipe load rejected: recipe schema_version \"" + recipe.schema_version +
        "\" is not supported by executor 1.x, which supports recipe 1.0.x. " +
        "The recipe is not executed at all.");
    }
    if (!Array.isArray(recipe.items) || recipe.items.length < 1) {
      throw new Error("recipe load rejected: items must be a non-empty array.");
    }
    for (var i = 0; i < recipe.items.length; i++) {
      var item = recipe.items[i];
      if (!item || typeof item !== "object") {
        throw new Error("recipe load rejected: item " + i + " must be an object.");
      }
      if (U.ACTIONS.indexOf(item.intent) === -1) {
        throw new Error("recipe load rejected: item " + i + " has unknown intent \"" + item.intent + "\".");
      }
      if (!item.params || typeof item.params !== "object" || Array.isArray(item.params)) {
        throw new Error("recipe load rejected: item " + i + " params must be an object.");
      }
      var bytes = U.utf8ByteLength(U.canon(item.params));
      if (bytes > U.MAX_PARAMS_BYTES) {
        throw new Error(
          "recipe load rejected: item " + i + " params serialize to " + bytes +
          " bytes, over the 4096-byte limit.");
      }
    }
  }

  function Executor(recipe) {
    checkRecipe(recipe);
    this._recipe = U.deepCopy(recipe);
    this._recipeId = recipe.recipe_id;
    this._items = this._recipe.items;
    this._seq = 0;               /* guide seq: monotonic, never decrements */
    this._nodes = {};            /* node_id -> {type, x, y, label} */
    this._edges = [];            /* [{a, b, cat}] */
    this._annotations = [];      /* [{kind, node_id, payload}] */
    this._appliedKeys = {};      /* idempotency key -> {action_record, result} */
    this._actions = [];          /* last WINDOW_N action records, oldest first */
    this._droppedCount = 0;
    this._prefixHash = H0;
    this._itemIndex = 0;
    this._terminated = false;
    this._abortReason = null;
    this._tombstones = {};       /* key -> true (Set port) */
    this._history = [];          /* applied mutating actions with inverse data */
    this._done = {};             /* completed item indices (executed or skipped) */
    this._skipped = {};          /* skipped item indices */
  }

  Executor.prototype._key = function (actionName, itemIndex) {
    return U.sha256hex(this._recipeId + "\0" + itemIndex + "\0" + actionName);
  };

  Executor.prototype._flagOpen = function () {
    return this._annotations.some(function (a) { return a.kind === "review_flag"; });
  };

  Executor.prototype._undoTarget = function () {
    for (var i = this._history.length - 1; i >= 0; i--) {
      var h = this._history[i];
      if (!h.undone && h.name !== "undo_last") return h;
    }
    return null;
  };

  Executor.prototype._undoable = function () {
    return this._undoTarget() !== null;
  };

  Executor.prototype.validMenu = function () {
    return M.validMenu(this);
  };

  Executor.prototype.stateHash = function () {
    var self = this;
    var nodes = Object.keys(this._nodes)
      .sort(function (a, b) { return U.nodeNum(a) - U.nodeNum(b); })
      .map(function (id) {
        var n = self._nodes[id];
        return { id: id, label: n.label, type: n.type, x: U.roundHalfUp(n.x), y: U.roundHalfUp(n.y) };
      });
    var edges = this._edges
      .map(function (e) { return { a: e.a, b: e.b, cat: e.cat }; })
      .sort(function (p, q) {
        return U.nodeNum(p.a) - U.nodeNum(q.a) ||
          U.nodeNum(p.b) - U.nodeNum(q.b) ||
          U.EDGE_CAT_ORDER[p.cat] - U.EDGE_CAT_ORDER[q.cat];
      });
    var annotations = this._annotations
      .map(function (a) { return { kind: a.kind, node_id: a.node_id, payload: U.deepCopy(a.payload) }; })
      .sort(function (p, q) {
        return U.nodeNum(p.node_id) - U.nodeNum(q.node_id) ||
          (p.kind < q.kind ? -1 : p.kind > q.kind ? 1 : 0) ||
          U.compareUtf8Bytes(U.canon(p.payload), U.canon(q.payload));
      });
    return U.sha256hex(U.canon({ nodes: nodes, edges: edges, annotations: annotations }));
  };

  Executor.prototype.snapshot = function () {
    return {
      snapshot_version: SNAPSHOT_VERSION,
      recipe_id: this._recipeId,
      item_index: this._itemIndex,
      canvas: {
        nodes: U.deepCopy(this._nodes),
        edges: U.deepCopy(this._edges)
      },
      annotations: U.deepCopy(this._annotations),
      applied_keys: U.deepCopy(this._appliedKeys),
      actions: U.deepCopy(this._actions),
      dropped_prefix: { count: this._droppedCount, prefix_hash: this._prefixHash },
      terminated: this._terminated,
      abort_reason: this._abortReason
    };
  };

  Executor.prototype._pushRecord = function (record) {
    this._actions.push(record);
    while (this._actions.length > WINDOW_N) {
      var dropped = this._actions.shift();
      this._droppedCount += 1;
      this._prefixHash = U.sha256hex(this._prefixHash + dropped.state_hash);
    }
  };

  Executor.prototype.apply = function (actionName, params) {
    var p = (params === undefined || params === null) ? {} : params;
    var itemIndex = this._itemIndex;
    var key = this._key(actionName, itemIndex);
    if (this._tombstones[key]) {
      throw new Error(
        "replay rejected: " + actionName + " at item " + itemIndex + " was undone and its key is tombstoned; " +
        "a stale replay cannot resurrect it.");
    }
    var recorded = this._appliedKeys[key];
    if (recorded) {
      return { action_record: recorded.action_record, snapshot: this.snapshot() };
    }
    if (this._terminated) {
      throw new Error(
        "rejected: the session was terminated (reason: " + this._abortReason + "); " +
        "a terminated session never resumes.");
    }
    var menu = this.validMenu();
    var entry = null;
    for (var i = 0; i < menu.length; i++) {
      if (menu[i].action_name === actionName) { entry = menu[i]; break; }
    }
    if (!entry) {
      var why = this._flagOpen()
        ? "a review flag is open, so only undo_last, flag_for_review, and abort_session are allowed"
        : (this._itemIndex >= this._items.length
          ? "the recipe is complete; only recovery actions remain"
          : "the current item is \"" + this._items[this._itemIndex].intent + "\"");
      throw new Error("rejected: \"" + actionName + "\" is not in the valid-action menu at item " + itemIndex + " (" + why + ").");
    }

    var done = this._execute(actionName, p, itemIndex);
    var stateHash = this.stateHash();
    var action_record = {
      action_id: actionName + ":" + itemIndex,
      params: U.deepCopy(p),
      state_hash: stateHash
    };
    this._pushRecord(action_record);
    this._appliedKeys[key] = { action_record: U.deepCopy(action_record), result: U.deepCopy(done.result) };
    if (done.mutating) {
      this._history.push({ key: key, name: actionName, item_index: itemIndex, inverse: done.inverse, undone: false });
    }
    if (actionName === "skip_recipe_item") {
      this._skipped[itemIndex] = true;
      this._done[itemIndex] = true;
      this._itemIndex += 1;
    } else if (actionName === "abort_session") {
      this._terminated = true;
      this._abortReason = p.reason;
    } else if (this._itemIndex < this._items.length && actionName === this._items[this._itemIndex].intent) {
      this._done[itemIndex] = true;
      this._itemIndex += 1;
    }
    return { action_record: action_record, snapshot: this.snapshot() };
  };

  Executor.prototype._execute = function (actionName, p, itemIndex) {
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
      default: throw new Error("rejected: unknown action \"" + actionName + "\".");
    }
  };

  Executor.prototype._checkIntentParams = function (actionName, p, itemIndex) {
    var item = this._items[itemIndex];
    if (!item || item.intent !== actionName) {
      throw new Error("rejected: \"" + actionName + "\" is not the current recipe item's intent.");
    }
    if (U.canon(p) !== U.canon(item.params)) {
      throw new Error(
        "rejected: \"" + actionName + "\" params do not match the recipe item " + itemIndex + " params exactly.");
    }
  };

  Executor.prototype._requireNode = function (node_id, actionName) {
    if (!U.NODE_ID_RE.test(node_id || "") || !this._nodes[node_id]) {
      throw new Error(actionName + " rejected: node \"" + node_id + "\" does not exist.");
    }
  };

  Executor.prototype._doAddNode = function (p, collectionPoint) {
    var actionName = collectionPoint ? "add_collection_point" : "add_node";
    this._checkIntentParams(actionName, p, this._itemIndex);
    var expected = "n" + (this._seq + 1);
    if (p.node_id !== expected) {
      throw new Error(
        actionName + " rejected: node_id \"" + p.node_id + "\" is out of sequence; the guide seq is " +
        this._seq + ", so the next node id must be \"" + expected + "\".");
    }
    var type = collectionPoint ? "collection" : p.type;
    if (!collectionPoint && U.NODE_TYPES.indexOf(p.type) === -1) {
      throw new Error(actionName + " rejected: unknown node type \"" + p.type + "\".");
    }
    var ranges = [["x", 40, 600], ["y", 40, 380]];
    for (var i = 0; i < ranges.length; i++) {
      var k = ranges[i][0], lo = ranges[i][1], hi = ranges[i][2];
      if (typeof p[k] !== "number" || !isFinite(p[k]) || p[k] < lo || p[k] > hi) {
        throw new Error(actionName + " rejected: " + k + " must be a number in [" + lo + ", " + hi + "]; got " + JSON.stringify(p[k]) + ".");
      }
    }
    if (typeof p.label !== "string" || p.label.length < 1 || p.label.length > 200) {
      throw new Error(actionName + " rejected: label must be 1-200 characters.");
    }
    if (Object.keys(this._nodes).length >= U.MAX_NODES) {
      throw new Error(actionName + " rejected: the canvas already holds " + U.MAX_NODES + " nodes (the frozen limit).");
    }
    this._nodes[p.node_id] = { type: type, x: p.x, y: p.y, label: p.label };
    this._seq += 1;
    return {
      mutating: true,
      result: { node_id: p.node_id, type: type, seq: this._seq },
      inverse: { op: "delete_node", node_id: p.node_id }
    };
  };

  Executor.prototype._doConnect = function (p) {
    this._checkIntentParams("connect", p, this._itemIndex);
    this._requireNode(p.a, "connect");
    this._requireNode(p.b, "connect");
    if (p.a === p.b) throw new Error("connect rejected: self-loops are not allowed (" + p.a + " to itself).");
    if (U.EDGE_CATS.indexOf(p.cat) === -1) throw new Error("connect rejected: unknown edge category \"" + p.cat + "\".");
    var dup = this._edges.some(function (e) {
      return (e.a === p.a && e.b === p.b) || (e.a === p.b && e.b === p.a);
    });
    if (dup) throw new Error("connect rejected: " + p.a + " and " + p.b + " are already connected in one direction.");
    if (this._edges.length >= U.MAX_EDGES) {
      throw new Error("connect rejected: the canvas already holds " + U.MAX_EDGES + " edges (the frozen limit).");
    }
    this._edges.push({ a: p.a, b: p.b, cat: p.cat });
    return {
      mutating: true,
      result: { a: p.a, b: p.b, cat: p.cat },
      inverse: { op: "remove_edge", a: p.a, b: p.b, cat: p.cat }
    };
  };

  Executor.prototype._doSetField = function (p) {
    this._checkIntentParams("set_field", p, this._itemIndex);
    this._requireNode(p.node_id, "set_field");
    if (["label", "x", "y"].indexOf(p.field) === -1) {
      throw new Error("set_field rejected: unknown field \"" + p.field + "\"; only label, x, y are writable.");
    }
    var node = this._nodes[p.node_id];
    var oldValue = node[p.field];
    if (p.field === "label") {
      if (typeof p.value !== "string" || p.value.length < 1 || p.value.length > 200) {
        throw new Error("set_field rejected: label must be a string of 1-200 characters.");
      }
    } else {
      var lo = p.field === "x" ? 40 : 40, hi = p.field === "x" ? 600 : 380;
      if (typeof p.value !== "number" || !isFinite(p.value) || p.value < lo || p.value > hi) {
        throw new Error(
          "set_field rejected: " + p.field + " must be a number in [" + lo + ", " + hi + "] (out-of-range values are " +
          "rejected, never clamped); got " + JSON.stringify(p.value) + ".");
      }
    }
    node[p.field] = p.value;
    return {
      mutating: true,
      result: { node_id: p.node_id, field: p.field, old_value: oldValue, new_value: p.value },
      inverse: { op: "restore_field", node_id: p.node_id, field: p.field, old_value: oldValue }
    };
  };

  Executor.prototype._doSetRetention = function (p) {
    this._checkIntentParams("set_retention", p, this._itemIndex);
    this._requireNode(p.node_id, "set_retention");
    if (typeof p.as_of !== "string" || !U.isRealDate(p.as_of)) {
      throw new Error("set_retention rejected: as_of must be a real calendar date in YYYY-MM-DD form.");
    }
    if (p.as_of > U.todayUtc()) {
      throw new Error("set_retention rejected: as_of \"" + p.as_of + "\" is in the future.");
    }
    if (typeof p.record_type !== "string" || p.record_type.length < 1 || p.record_type.length > 120) {
      throw new Error("set_retention rejected: record_type must be 1-120 characters.");
    }
    var verifyOnly = p.verify_only === true;
    var payload;
    if (verifyOnly) {
      payload = { record_type: p.record_type, verify_only: true, as_of: p.as_of };
    } else {
      var kk = ["range_min_years", "range_max_years"];
      for (var i = 0; i < kk.length; i++) {
        var k = kk[i];
        if (typeof p[k] !== "number" || !isFinite(p[k]) || p[k] <= 0) {
          throw new Error("set_retention rejected: " + k + " must be a number greater than 0.");
        }
      }
      if (!(p.range_min_years < p.range_max_years)) {
        throw new Error(
          "set_retention rejected: range_min_years (" + p.range_min_years + ") must be strictly less than " +
          "range_max_years (" + p.range_max_years + "); a single number is never accepted.");
      }
      var statuteProblem = U.checkStatute(p.statute);
      if (statuteProblem) {
        throw new Error("set_retention rejected: " + statuteProblem);
      }
      payload = {
        record_type: p.record_type,
        range_min_years: p.range_min_years,
        range_max_years: p.range_max_years,
        statute: p.statute,
        as_of: p.as_of
      };
    }
    if (typeof p.anchor === "string") {
      if (p.anchor.length > 120) throw new Error("set_retention rejected: anchor must be at most 120 characters.");
      if (p.anchor.length > 0) payload.anchor = p.anchor;
    }
    var prevIdx = -1;
    for (var j = 0; j < this._annotations.length; j++) {
      if (this._annotations[j].kind === "retention" && this._annotations[j].node_id === p.node_id) { prevIdx = j; break; }
    }
    var previous = prevIdx >= 0 ? this._annotations[prevIdx] : null;
    if (prevIdx >= 0) this._annotations.splice(prevIdx, 1);
    var annotation = { kind: "retention", node_id: p.node_id, payload: payload };
    this._annotations.push(annotation);
    return {
      mutating: true,
      result: { node_id: p.node_id, replaced: previous !== null },
      inverse: { op: "restore_retention", node_id: p.node_id, annotation: annotation, previous: previous }
    };
  };

  Executor.prototype._doConfirmNode = function (p, itemIndex) {
    this._checkIntentParams("confirm_node", p, this._itemIndex);
    this._requireNode(p.node_id, "confirm_node");
    if (p.note !== undefined && (typeof p.note !== "string" || p.note.length > 500)) {
      throw new Error("confirm_node rejected: note must be a string of at most 500 characters.");
    }
    this._annotations.push({
      kind: "confirmation",
      node_id: p.node_id,
      payload: { note: p.note === undefined ? "" : p.note, item_index: itemIndex }
    });
    return { mutating: false, result: { node_id: p.node_id, item_index: itemIndex }, inverse: null };
  };

  Executor.prototype._doFlag = function (p, itemIndex) {
    var nodeId = p.node_id;
    var flagItem = p.item_index;
    if (nodeId === undefined && flagItem === undefined) {
      flagItem = itemIndex;
    }
    if (nodeId !== undefined) this._requireNode(nodeId, "flag_for_review");
    if (flagItem !== undefined && (!Number.isInteger(flagItem) || flagItem < 0 || flagItem >= this._items.length)) {
      throw new Error("flag_for_review rejected: item_index " + flagItem + " does not reference a recipe item.");
    }
    if (nodeId === undefined && flagItem === undefined) {
      throw new Error("flag_for_review rejected: at least one of node_id or item_index is required.");
    }
    if (typeof p.reason !== "string" || p.reason.length < 1 || p.reason.length > 500) {
      throw new Error("flag_for_review rejected: reason must be 1-500 characters.");
    }
    var payload = { reason: p.reason, item_index: flagItem === undefined ? null : flagItem };
    if (nodeId !== undefined) payload.node_id = nodeId;
    var anchor = nodeId;
    if (anchor === undefined) {
      var ids = Object.keys(this._nodes).sort(function (a, b) { return U.nodeNum(a) - U.nodeNum(b); });
      anchor = ids[0];
      if (!anchor) anchor = "n" + (this._seq + 1);
    }
    var annotation = { kind: "review_flag", node_id: anchor, payload: payload };
    this._annotations.push(annotation);
    var openFlags = this._annotations.filter(function (a) { return a.kind === "review_flag"; }).length;
    return {
      mutating: true,
      result: { flag_open: true, open_flags: openFlags },
      inverse: { op: "clear_flag", annotation: annotation }
    };
  };

  Executor.prototype._doRunCheck = function (p) {
    this._checkIntentParams("run_check", p, this._itemIndex);
    if (!Array.isArray(p.checks) || p.checks.length < 1) {
      throw new Error("run_check rejected: checks must be a non-empty array.");
    }
    var seen = {};
    for (var i = 0; i < p.checks.length; i++) {
      if (seen[p.checks[i]]) throw new Error("run_check rejected: checks must be unique.");
      seen[p.checks[i]] = true;
      if (U.CHECK_NAMES.indexOf(p.checks[i]) === -1) {
        throw new Error("run_check rejected: unknown check \"" + p.checks[i] + "\".");
      }
    }
    var self = this;
    var ids = Object.keys(this._nodes).sort(function (a, b) { return U.nodeNum(a) - U.nodeNum(b); });
    var report = {};
    if (p.checks.indexOf("label_coverage") !== -1) {
      var missing = ids.filter(function (id) {
        var l = self._nodes[id].label;
        return !l || l.toLowerCase() === "untitled";
      });
      report.label_coverage = {
        pass: missing.length === 0,
        findings: missing.map(function (id) { return "node " + id + " has no usable label"; })
      };
    }
    if (p.checks.indexOf("connectivity") !== -1) {
      var findings = [];
      var touches = function (id, wantSystem) {
        return self._edges.some(function (e) {
          var other = e.a === id ? e.b : e.b === id ? e.a : null;
          if (other === null) return false;
          return wantSystem ? self._nodes[other].type === "system" : true;
        });
      };
      for (var j = 0; j < ids.length; j++) {
        var id = ids[j], t = self._nodes[id].type;
        if (t === "destruction") continue;
        if (t === "collection" && !touches(id, true)) {
          findings.push("collection node " + id + " has no edge to a system node");
        } else if (t !== "collection" && !touches(id, false)) {
          findings.push("node " + id + " participates in no edge");
        }
      }
      report.connectivity = { pass: findings.length === 0, findings: findings };
    }
    if (p.checks.indexOf("retention_cited") !== -1) {
      var rfind = [];
      for (var m = 0; m < ids.length; m++) {
        var nid = ids[m], nt = self._nodes[nid].type;
        if (nt !== "system" && nt !== "thirdparty") continue;
        var ann = null;
        for (var a = 0; a < self._annotations.length; a++) {
          if (self._annotations[a].kind === "retention" && self._annotations[a].node_id === nid) {
            ann = self._annotations[a]; break;
          }
        }
        var cited = ann && (ann.payload.verify_only === true || typeof ann.payload.range_max_years === "number");
        if (!cited) rfind.push("node " + nid + " (" + nt + ") has no retention citation");
      }
      report.retention_cited = { pass: rfind.length === 0, findings: rfind };
    }
    if (p.checks.indexOf("edge_categories") !== -1) {
      var bad = self._edges.filter(function (e) { return U.EDGE_CATS.indexOf(e.cat) === -1; });
      report.edge_categories = {
        pass: bad.length === 0,
        findings: bad.map(function (e) { return "edge " + e.a + "->" + e.b + " has unknown category " + e.cat; })
      };
    }
    return { mutating: false, result: { report: report }, inverse: null };
  };

  Executor.prototype._doExport = function (p) {
    this._checkIntentParams("export", p, this._itemIndex);
    if (p.format !== "xls") {
      throw new Error("export rejected: format must be \"xls\"; got " + JSON.stringify(p.format) + ".");
    }
    if (Object.keys(this._nodes).length < 1) {
      throw new Error("export rejected: the canvas is empty.");
    }
    return {
      mutating: false,
      result: {
        downloaded: "data-map-inventory.xls",
        nodes: Object.keys(this._nodes).length,
        edges: this._edges.length
      },
      inverse: null
    };
  };

  Executor.prototype._doSkip = function (p, itemIndex) {
    if (!Number.isInteger(p.item_index) || p.item_index !== itemIndex) {
      throw new Error(
        "skip_recipe_item rejected: item_index must equal the current item_index (" + itemIndex + "); " +
        "only the current item may be skipped.");
    }
    if (itemIndex >= this._items.length) {
      throw new Error("skip_recipe_item rejected: there is no current item left to skip.");
    }
    if (this._done[itemIndex]) {
      throw new Error("skip_recipe_item rejected: item " + itemIndex + " already completed successfully.");
    }
    if (typeof p.reason !== "string" || p.reason.length < 1 || p.reason.length > 200) {
      throw new Error("skip_recipe_item rejected: reason must be 1-200 characters.");
    }
    return { mutating: false, result: { skipped_item: itemIndex, reason: p.reason }, inverse: null };
  };

  Executor.prototype._doUndo = function () {
    var target = this._undoTarget();
    if (!target) {
      throw new Error("undo_last rejected: no applied mutating action is left to undo.");
    }
    this._applyInverse(target.inverse);
    target.undone = true;
    this._tombstones[target.key] = true;
    return {
      mutating: true,
      result: {
        undone_action: target.name,
        undone_action_id: target.name + ":" + target.item_index,
        tombstoned_key: target.key
      },
      inverse: null
    };
  };

  Executor.prototype._applyInverse = function (inv) {
    if (!inv) return;
    switch (inv.op) {
      case "delete_node": {
        delete this._nodes[inv.node_id];
        this._edges = this._edges.filter(function (e) { return e.a !== inv.node_id && e.b !== inv.node_id; });
        break;
      }
      case "remove_edge": {
        var i = -1;
        for (var k = 0; k < this._edges.length; k++) {
          var e = this._edges[k];
          if (e.a === inv.a && e.b === inv.b && e.cat === inv.cat) { i = k; break; }
        }
        if (i >= 0) this._edges.splice(i, 1);
        break;
      }
      case "restore_field": {
        if (this._nodes[inv.node_id]) this._nodes[inv.node_id][inv.field] = inv.old_value;
        break;
      }
      case "restore_retention": {
        var r = this._annotations.indexOf(inv.annotation);
        if (r >= 0) this._annotations.splice(r, 1);
        if (inv.previous) this._annotations.push(inv.previous);
        break;
      }
      case "clear_flag": {
        var c = this._annotations.indexOf(inv.annotation);
        if (c >= 0) this._annotations.splice(c, 1);
        break;
      }
      default:
        throw new Error("internal error: unknown undo op \"" + inv.op + "\".");
    }
  };

  Executor.prototype._doAbort = function (p) {
    if (typeof p.reason !== "string" || p.reason.length < 1 || p.reason.length > 500) {
      throw new Error("abort_session rejected: reason must be 1-500 characters.");
    }
    return { mutating: false, result: { terminated: true, reason: p.reason }, inverse: null };
  };

  /* UI-layer extension: the recorded result for an applied action.
     apply() itself returns {action_record, snapshot} like the teacher;
     the result lives in the idempotency map, retrievable here. */
  Executor.prototype.resultFor = function (actionName, itemIndex) {
    var rec = this._appliedKeys[this._key(actionName, itemIndex)];
    return rec ? U.deepCopy(rec.result) : null;
  };

  /* ------------------------------------------------------------------
   * UI-layer extensions for the review loop. The teacher documents the
   * out-of-band rule for flag clearing ("A flag is cleared by a human
   * out-of-band through the review UI"); the review UI may touch the
   * session layer the same way for confirmations and human corrections.
   * These paths never go through validMenu/apply, and they are logged by
   * the review UI as structured correction lines for future training.
   * ------------------------------------------------------------------ */

  Executor.prototype._pushAnnotation = function (annotation) {
    this._annotations.push(annotation);
  };

  /** Out-of-band: record a human confirmation (review pass). */
  Executor.prototype.recordConfirmationOutOfBand = function (node_id, note, item_index) {
    this._requireNode(node_id, "confirm_node");
    if (note !== undefined && note !== null && (typeof note !== "string" || note.length > 500)) {
      throw new Error("confirm_node rejected: note must be a string of at most 500 characters.");
    }
    this._pushAnnotation({
      kind: "confirmation",
      node_id: node_id,
      payload: { note: note || "", item_index: item_index }
    });
    return { node_id: node_id, item_index: item_index };
  };

  /** Out-of-band: clear all open review flags (human, via the review UI). */
  Executor.prototype.clearFlagsOutOfBand = function () {
    var before = this._annotations.length;
    this._annotations = this._annotations.filter(function (a) { return a.kind !== "review_flag"; });
    return { cleared: before - this._annotations.length };
  };

  /* UI-layer extension: find a free canvas spot for a review-added node.
     Scans a coarse grid inside the legal canvas area (x 40..600, y 40..380)
     for the first cell whose center is at least 70px from every existing
     node; falls back to the canvas center. */
  Executor.prototype._freeSpot = function () {
    var xs = [80, 200, 320, 440, 560], ys = [80, 170, 260, 350];
    var ids = Object.keys(this._nodes);
    for (var yi = 0; yi < ys.length; yi++) {
      for (var xi = 0; xi < xs.length; xi++) {
        var ok = true;
        for (var k = 0; k < ids.length; k++) {
          var n = this._nodes[ids[k]];
          if (Math.abs(n.x - xs[xi]) < 70 && Math.abs(n.y - ys[yi]) < 70) { ok = false; break; }
        }
        if (ok) return { x: xs[xi], y: ys[yi] };
      }
    }
    return { x: 320, y: 210 };
  };

  /**
   * Out-of-band: apply a human correction instantly. op is one of:
   *  {op:"relabel", node_id, label} | {op:"retype", node_id, type} |
   *  {op:"move", node_id, x, y} | {op:"reconnect", a, b, cat} |
   *  {op:"remove_edge", a, b} | {op:"verify_only", node_id} |
   *  {op:"remove_node", node_id} |
   *  {op:"add_node", type, label} | {op:"add_edge", a, b, cat} |
   *  {op:"set_meta", node_id | (a, b), meta} | {op:"remove_retention", node_id}
   * add_node allocates the next free node id (max numeric suffix + 1) and
   * a free canvas spot; it never touches the guide seq (the recipe run is
   * over by review time). set_meta merges whitelisted string fields into
   * node.meta / edge.meta (plain object, created on demand).
   * Returns a correction record {op, before, after} for the JSONL log.
   */
  Executor.prototype.applyCorrection = function (op) {
    var before = null, after = null;
    switch (op.op) {
      case "add_node": {
        if (U.NODE_TYPES.indexOf(op.type) === -1) {
          throw new Error("add_node rejected: unknown node type \"" + op.type + "\".");
        }
        if (typeof op.label !== "string" || op.label.length < 1 || op.label.length > 200) {
          throw new Error("add_node rejected: label must be 1-200 characters.");
        }
        if (Object.keys(this._nodes).length >= U.MAX_NODES) {
          throw new Error("add_node rejected: the canvas already holds " + U.MAX_NODES + " nodes (the frozen limit).");
        }
        var maxN = 0;
        Object.keys(this._nodes).forEach(function (id) {
          var n = U.nodeNum(id);
          if (n > maxN) maxN = n;
        });
        var nid = "n" + (maxN + 1);
        var spot = this._freeSpot();
        this._nodes[nid] = { type: op.type, x: spot.x, y: spot.y, label: op.label };
        after = { node_id: nid, type: op.type, label: op.label, x: spot.x, y: spot.y };
        break;
      }
      case "add_edge": {
        this._requireNode(op.a, "add_edge");
        this._requireNode(op.b, "add_edge");
        if (op.a === op.b) throw new Error("add_edge rejected: self-loops are not allowed.");
        if (U.EDGE_CATS.indexOf(op.cat) === -1) {
          throw new Error("add_edge rejected: unknown edge category \"" + op.cat + "\".");
        }
        var dup = this._edges.some(function (e) {
          return (e.a === op.a && e.b === op.b) || (e.a === op.b && e.b === op.a);
        });
        if (dup) throw new Error("add_edge rejected: " + op.a + " and " + op.b + " are already connected.");
        if (this._edges.length >= U.MAX_EDGES) {
          throw new Error("add_edge rejected: the canvas already holds " + U.MAX_EDGES + " edges (the frozen limit).");
        }
        this._edges.push({ a: op.a, b: op.b, cat: op.cat });
        after = { a: op.a, b: op.b, cat: op.cat };
        break;
      }
      case "set_meta": {
        var target = null;
        if (op.node_id !== undefined && op.node_id !== null) {
          this._requireNode(op.node_id, "set_meta");
          target = this._nodes[op.node_id];
        } else {
          this._requireNode(op.a, "set_meta");
          this._requireNode(op.b, "set_meta");
          for (var mi = 0; mi < this._edges.length; mi++) {
            var me = this._edges[mi];
            if ((me.a === op.a && me.b === op.b) || (me.a === op.b && me.b === op.a)) { target = me; break; }
          }
          if (!target) throw new Error("set_meta rejected: no such edge.");
        }
        if (!op.meta || typeof op.meta !== "object" || Array.isArray(op.meta)) {
          throw new Error("set_meta rejected: meta must be an object.");
        }
        var META_MAX = {
          sys_kind: 60, holds: 500, region: 120, collect_how: 60,
          notes: 500, service: 500, data_shared: 500, why: 500
        };
        before = U.deepCopy(target.meta || {});
        var merged = U.deepCopy(target.meta || {});
        Object.keys(op.meta).forEach(function (k) {
          if (!Object.prototype.hasOwnProperty.call(META_MAX, k)) {
            throw new Error("set_meta rejected: unknown meta field \"" + k + "\".");
          }
          var v = op.meta[k];
          if (typeof v !== "string" || v.length > META_MAX[k]) {
            throw new Error("set_meta rejected: field \"" + k + "\" must be a string of at most " + META_MAX[k] + " characters.");
          }
          if (v.length === 0) delete merged[k];
          else merged[k] = v;
        });
        target.meta = merged;
        after = U.deepCopy(merged);
        break;
      }
      case "remove_retention": {
        this._requireNode(op.node_id, "remove_retention");
        var ri2 = -1;
        for (var r2 = 0; r2 < this._annotations.length; r2++) {
          if (this._annotations[r2].kind === "retention" && this._annotations[r2].node_id === op.node_id) { ri2 = r2; break; }
        }
        if (ri2 < 0) throw new Error("remove_retention rejected: no retention note on node \"" + op.node_id + "\".");
        before = U.deepCopy(this._annotations[ri2].payload);
        this._annotations.splice(ri2, 1);
        after = null;
        break;
      }
      case "relabel": {
        this._requireNode(op.node_id, "relabel");
        if (typeof op.label !== "string" || op.label.length < 1 || op.label.length > 200) {
          throw new Error("relabel rejected: label must be 1-200 characters.");
        }
        before = { label: this._nodes[op.node_id].label };
        this._nodes[op.node_id].label = op.label;
        after = { label: op.label };
        break;
      }
      case "retype": {
        this._requireNode(op.node_id, "retype");
        if (U.NODE_TYPES.indexOf(op.type) === -1) {
          throw new Error("retype rejected: unknown node type \"" + op.type + "\".");
        }
        before = { type: this._nodes[op.node_id].type };
        this._nodes[op.node_id].type = op.type;
        after = { type: op.type };
        break;
      }
      case "move": {
        this._requireNode(op.node_id, "move");
        if (typeof op.x !== "number" || op.x < 40 || op.x > 600 ||
            typeof op.y !== "number" || op.y < 40 || op.y > 380) {
          throw new Error("move rejected: coordinates out of range.");
        }
        before = { x: this._nodes[op.node_id].x, y: this._nodes[op.node_id].y };
        this._nodes[op.node_id].x = op.x;
        this._nodes[op.node_id].y = op.y;
        after = { x: op.x, y: op.y };
        break;
      }
      case "reconnect": {
        this._requireNode(op.a, "reconnect");
        this._requireNode(op.b, "reconnect");
        if (op.a === op.b) throw new Error("reconnect rejected: self-loops are not allowed.");
        if (U.EDGE_CATS.indexOf(op.cat) === -1) {
          throw new Error("reconnect rejected: unknown edge category \"" + op.cat + "\".");
        }
        var idx = -1;
        for (var i = 0; i < this._edges.length; i++) {
          var e = this._edges[i];
          if ((e.a === op.a && e.b === op.b) || (e.a === op.b && e.b === op.a)) { idx = i; break; }
        }
        before = idx >= 0 ? U.deepCopy(this._edges[idx]) : null;
        if (idx >= 0) this._edges.splice(idx, 1);
        this._edges.push({ a: op.a, b: op.b, cat: op.cat });
        after = { a: op.a, b: op.b, cat: op.cat };
        break;
      }
      case "remove_edge": {
        this._requireNode(op.a, "remove_edge");
        this._requireNode(op.b, "remove_edge");
        var ri = -1;
        for (var j = 0; j < this._edges.length; j++) {
          var e2 = this._edges[j];
          if ((e2.a === op.a && e2.b === op.b) || (e2.a === op.b && e2.b === op.a)) { ri = j; break; }
        }
        if (ri < 0) throw new Error("remove_edge rejected: no such edge.");
        before = U.deepCopy(this._edges[ri]);
        this._edges.splice(ri, 1);
        after = null;
        break;
      }
      case "verify_only": {
        this._requireNode(op.node_id, "verify_only");
        var vi = -1;
        for (var v = 0; v < this._annotations.length; v++) {
          if (this._annotations[v].kind === "retention" && this._annotations[v].node_id === op.node_id) { vi = v; break; }
        }
        before = vi >= 0 ? U.deepCopy(this._annotations[vi].payload) : null;
        var payload = {
          record_type: op.record_type || (before && before.record_type) || "records",
          verify_only: true,
          as_of: U.todayUtc()
        };
        if (vi >= 0) this._annotations.splice(vi, 1);
        this._annotations.push({ kind: "retention", node_id: op.node_id, payload: payload });
        after = payload;
        break;
      }
      case "remove_node": {
        this._requireNode(op.node_id, "remove_node");
        before = U.deepCopy(this._nodes[op.node_id]);
        delete this._nodes[op.node_id];
        this._edges = this._edges.filter(function (e) { return e.a !== op.node_id && e.b !== op.node_id; });
        this._annotations = this._annotations.filter(function (a) { return a.node_id !== op.node_id; });
        after = null;
        break;
      }
      default:
        throw new Error("rejected: unknown correction op \"" + op.op + "\".");
    }
    return { op: op.op, before: before, after: after };
  };

  return {
    Executor: Executor,
    SNAPSHOT_VERSION: SNAPSHOT_VERSION,
    EXECUTOR_VERSION: EXECUTOR_VERSION
  };
});
