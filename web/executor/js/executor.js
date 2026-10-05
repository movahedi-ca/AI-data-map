/**
 * executor.js - ONNX session lifecycle and the per-step model loop.
 *
 * Per the ONNX I/O contract (section 3), one step is:
 *   menu = validMenu(state)                      (S1Menu, S1Apply)
 *   ids/fields = frozen ordering serialization    (serializeStep, below)
 *   encoded = S1Tokenize.encodeStep(...)         (DO NOT reimplement)
 *   feeds = int64/bool tensors, B=1               (ort.Tensor)
 *   scores = session.run(feeds).menu_scores       (float32, -inf off-menu)
 *   best = argmax over menu-masked positions
 *   entry = menu[menuIndex(best)]                 (S1Menu.entryForArgmax)
 *   result = executor.apply(entry.action_name, fullParams(entry))
 *
 * The model's choice is applied faithfully: the loop never substitutes a
 * scripted action. Recovery entries chosen by the model get operator-authored
 * params at apply time (canned defaults, domain contract Q4).
 *
 * Depends on (load order): s1tokenize.js, s1util.js, menu.js, apply.js.
 * UMD-ish: attaches window.__s1executor (test hooks) and window.S1Executor.
 * No network beyond same-origin vendored assets, no storage, no em dashes.
 */
(function (root, factory) {
  "use strict";
  var api = factory(root.S1Tokenize, root.S1Util, root.S1Menu, root.S1Apply, root.S1Narrate);
  if (typeof module === "object" && module !== null && typeof module.exports === "object") {
    module.exports = api;
  } else {
    root.S1Executor = api;
    root.__s1executor = api.hooks;
  }
})(typeof self !== "undefined" ? self : this, function (ST, U, M, A, N) {
  "use strict";

  if (!ST || !U || !M || !A) {
    throw new Error("executor.js requires s1tokenize.js, s1util.js, menu.js, apply.js to load first.");
  }

  /* Pinned model identity (vendor/VENDOR-MANIFEST.md). Mismatch refuses to run. */
  var MODEL_SHA256 = "f5f15612c294b37955d416aafdfccd127361ee2bddc509d3c6ea3eefdbe1de62";
  var ENCODING_VERSION = "1.0.0";
  var MAX_STEPS = 512;

  /* Canned operator-authored params for recovery entries the model may pick
     (domain contract Q4 default for abort; analogous plain-language defaults
     for skip and flag). Labeled as assistant-authored in the step log. */
  var CANNED = {
    en: {
      abort: "Operator stopped the session.",
      skip: "Assistant skipped this step; the map may be incomplete.",
      flag: "Assistant flagged this step for human review."
    },
    fr: {
      abort: "Session arrêtée par l'utilisateur.",
      skip: "L'assistant a sauté cette étape; la carte peut être incomplète.",
      flag: "L'assistant a signalé cette étape pour révision."
    }
  };

  /* ------------------------------------------------------------------ */
  /* Base URL resolution: capture document.currentScript at evaluation.   */
  /* ------------------------------------------------------------------ */
  var SCRIPT_BASE = (function () {
    try {
      var cs = (typeof document !== "undefined") ? document.currentScript : null;
      if (cs && cs.src) {
        var u = new URL(cs.src, (typeof location !== "undefined") ? location.href : "http://localhost/");
        var dir = u.href.slice(0, u.href.lastIndexOf("/") + 1);
        /* js/ -> executor/ */
        return dir.replace(/js\/$/, "");
      }
    } catch (e) { /* fall through */ }
    return null;
  })();

  function vendorUrl(path) {
    if (SCRIPT_BASE) return new URL(path, SCRIPT_BASE).href;
    return path;
  }

  /* ------------------------------------------------------------------ */
  /* Session lifecycle                                                   */
  /* ------------------------------------------------------------------ */
  var _ortReady = null;
  var _session = null;
  var _modelUrl = null;

  function ortApi() {
    return (typeof window !== "undefined" && window.ort) || (typeof self !== "undefined" && self.ort) || null;
  }

  function sha256BytesHex(buffer) {
    var digest = (typeof crypto !== "undefined" && crypto.subtle)
      ? crypto.subtle.digest("SHA-256", buffer)
      : Promise.reject(new Error("SubtleCrypto unavailable; cannot verify the model."));
    return digest.then(function (d) {
      var bytes = new Uint8Array(d), s = "";
      for (var i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
      return s;
    });
  }

  /**
   * Load ort (same-origin script tag must already be present), point the
   * wasm loader at the vendored ort dir, verify the model hash in-browser,
   * and create the InferenceSession. Idempotent.
   */
  function ready() {
    if (_ortReady) return _ortReady;
    _ortReady = (async function () {
      var ort = ortApi();
      if (!ort) throw new Error("onnxruntime-web (ort) is not loaded; the vendor script tag is missing.");
      var wasmDir = vendorUrl("vendor/ort/");
      if (ort.env && ort.env.wasm) {
        ort.env.wasm.wasmPaths = wasmDir;
      }
      _modelUrl = vendorUrl("vendor/model/model.onnx");
      var resp = await fetch(_modelUrl, { credentials: "same-origin" });
      if (!resp.ok) throw new Error("could not fetch the vendored model (" + resp.status + ").");
      var buf = await resp.arrayBuffer();
      var hash = await sha256BytesHex(buf);
      if (hash !== MODEL_SHA256) {
        throw new Error("model hash mismatch: refusing to run. Expected " + MODEL_SHA256 + ", got " + hash + ".");
      }
      /* The weights live in the model.onnx.data sidecar. onnxruntime-web
         1.20.1 only mounts external data when it is passed explicitly via
         the externalData session option (path must match the location
         attribute inside model.onnx); otherwise the wasm deserializer
         fails with "Module.MountedFiles is not available". */
      var dataUrl = _modelUrl.replace(/model\.onnx$/, "model.onnx.data");
      _session = await ort.InferenceSession.create(_modelUrl, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
        externalData: [{ data: dataUrl, path: "model.onnx.data" }]
      });
      /* Confirm the graph exposes the contracted I/O names. */
      var inNames = _session.inputNames || [];
      var outNames = _session.outputNames || [];
      ["tok_ids", "field_hash", "name_hash", "menu_mask"].forEach(function (n) {
        if (inNames.indexOf(n) === -1) throw new Error("model input \"" + n + "\" missing from the session.");
      });
      if (outNames.indexOf("menu_scores") === -1) throw new Error("model output \"menu_scores\" missing.");
      return { modelUrl: _modelUrl, inputNames: inNames, outputNames: outNames };
    })();
    return _ortReady;
  }

  /* ------------------------------------------------------------------ */
  /* Step serialization (frozen ordering rule)                           */
  /* ------------------------------------------------------------------ */

  function serializeStep(ex) {
    /* Node slots: node ids in numeric sort order. */
    var nodeIds = Object.keys(ex._nodes).sort(function (a, b) { return U.nodeNum(a) - U.nodeNum(b); });
    var slotOf = {};
    nodeIds.forEach(function (id, i) { slotOf[id] = i; });

    var ids = [], fields = [];
    ids.push(ST.BOS); fields.push({});

    nodeIds.forEach(function (id, slot) {
      var n = ex._nodes[id];
      ids.push(ST.NODE_LO + slot);
      fields.push({
        node_id: id,
        type: U.NODE_TYPE_ENUM[n.type],
        x: U.roundHalfUp(n.x),
        y: U.roundHalfUp(n.y),
        label: n.label
      });
    });

    ids.push(ST.SNAPSHOT_SEP); fields.push({});

    var edges = ex._edges.slice().sort(function (p, q) {
      return slotOf[p.a] - slotOf[q.a] ||
        slotOf[p.b] - slotOf[q.b] ||
        U.EDGE_CAT_ORDER[p.cat] - U.EDGE_CAT_ORDER[q.cat];
    });
    edges.forEach(function (e, i) {
      ids.push(ST.EDGE_LO + i);
      fields.push({ a: slotOf[e.a], b: slotOf[e.b], cat: U.EDGE_CAT_ENUM[e.cat] });
    });

    ids.push(ST.ANNOT_SEP); fields.push({});

    /* Annotation slot space: union of canvas node ids and annotation anchor
       ids, in node-id sort order (domain contract 4). */
    var anchorIds = {};
    ex._annotations.forEach(function (a) { anchorIds[a.node_id] = true; });
    var slotIds = nodeIds.slice();
    Object.keys(anchorIds).forEach(function (id) {
      if (slotOf[id] === undefined) slotIds.push(id);
    });
    slotIds.sort(function (a, b) { return U.nodeNum(a) - U.nodeNum(b); });
    var aslotOf = {};
    slotIds.forEach(function (id, i) { aslotOf[id] = i; });

    var KIND_ENUM = { retention: 0, confirmation: 1, review_flag: 2 };
    var annots = ex._annotations.map(function (a) { return a; });
    annots.sort(function (p, q) {
      var d = aslotOf[p.node_id] - aslotOf[q.node_id];
      if (d !== 0) return d;
      d = KIND_ENUM[p.kind] - KIND_ENUM[q.kind];
      if (d !== 0) return d;
      var cp = ST.canonicalFields(p.payload), cq = ST.canonicalFields(q.payload);
      return U.compareUtf8Bytes(cp, cq);
    });
    annots.forEach(function (a, i) {
      ids.push(ST.ANNOT_LO + i);
      fields.push({ node_slot: aslotOf[a.node_id], kind: KIND_ENUM[a.kind], payload: U.deepCopy(a.payload) });
    });

    ids.push(ST.MENU_SEP); fields.push({});

    var menu = ex.validMenu();
    var mfields = M.menuTokenFields(menu, "skeleton");
    mfields.forEach(function (f, j) {
      ids.push(ST.MENU_LO + j);
      fields.push({ action_name: f.action_name, params_digest: f.params_digest });
    });

    ids.push(ST.EOS); fields.push({});

    return { ids: ids, fields: fields, menu: menu };
  }

  /* ------------------------------------------------------------------ */
  /* The controller                                                      */
  /* ------------------------------------------------------------------ */

  function Controller() {
    this._ex = null;
    this._recipe = null;
    this._steps = [];
    this._runReports = {};   /* item_index -> run_check report */
    this._exportRecords = {}; /* item_index -> export result */
    this._lang = "en";
    this._sessionId = null;
    this._running = false;
    this._done = false;
  }

  Controller.prototype.setLang = function (lang) {
    this._lang = (lang === "fr") ? "fr" : "en";
  };

  Controller.prototype.start = function (recipe) {
    this._ex = new A.Executor(recipe);
    this._recipe = U.deepCopy(recipe);
    this._steps = [];
    this._runReports = {};
    this._exportRecords = {};
    this._sessionId = "s1-" + U.sha256hex(recipe.recipe_id + "\0" + Date.now()).slice(0, 12);
    this._running = false;
    this._done = false;
    return { recipe_id: recipe.recipe_id, items: recipe.items.length, session_id: this._sessionId };
  };

  Controller.prototype.lang = function () { return this._lang; };
  Controller.prototype.sessionId = function () { return this._sessionId; };
  Controller.prototype.executor = function () { return this._ex; };

  function fullParamsFor(entry, lang) {
    var p = U.deepCopy(entry.params);
    if (entry.action_name === "skip_recipe_item") {
      p.reason = CANNED[lang].skip;
    } else if (entry.action_name === "flag_for_review") {
      if (!p.reason) p.reason = CANNED[lang].flag;
      if (p.node_id === undefined && p.item_index === undefined) p.item_index = entry.item_index_hint;
    } else if (entry.action_name === "abort_session") {
      p.reason = CANNED[lang].abort;
    }
    return p;
  }

  /**
   * One model step: serialize, encode, run, argmax over menu positions,
   * apply. Returns the step record. Never substitutes a scripted action:
   * the applied action always comes from the argmax.
   */
  Controller.prototype.stepOnce = async function () {
    if (!this._ex) throw new Error("no session started; call start(recipe) first.");
    if (!this._session && typeof window !== "undefined") {
      if (!_session) await ready();
      this._session = _session;
    }
    var ex = this._ex;
    var stepIndex = this._steps.length;
    if (ex._terminated) return { terminal: "aborted", step_index: stepIndex };
    if (stepIndex >= MAX_STEPS) throw new Error("step limit exceeded; aborting the run.");

    var ser = serializeStep(ex);
    var jsonFields = ser.fields.map(function (f) { return JSON.stringify(f); });
    var enc = ST.encodeStep(ser.ids, jsonFields, 4096, 1024);
    var T = enc.tok_ids.length;

    var ort = ortApi();
    var feeds = {
      tok_ids: new ort.Tensor("int64", BigInt64Array.from(enc.tok_ids.map(function (v) { return BigInt(v); })), [1, T]),
      field_hash: new ort.Tensor("int64", BigInt64Array.from(enc.field_hash.map(function (v) { return BigInt(v); })), [1, T]),
      name_hash: new ort.Tensor("int64", BigInt64Array.from(enc.name_hash.map(function (v) { return BigInt(v); })), [1, T]),
      menu_mask: new ort.Tensor("bool", Uint8Array.from(enc.menu_mask.map(function (v) { return v ? 1 : 0; })), [1, T])
    };
    var out = await this._session.run(feeds);
    var scores = out.menu_scores.data; /* Float32Array, length T */

    /* Argmax over menu positions only (contract: -inf off-menu). */
    var best = -1, bestScore = -Infinity;
    for (var i = 0; i < T; i++) {
      if (enc.menu_mask[i] && scores[i] > bestScore) { bestScore = scores[i]; best = i; }
    }
    if (best < 0) throw new Error("no menu position carried a finite score; cannot choose an action.");

    var mapped = M.entryForArgmax(ser.menu, best, function (i) { return !!enc.menu_mask[i]; });
    var entry = mapped.entry;
    /* Tag the current item index for the flag default-target rule. */
    entry.item_index_hint = ex._itemIndex;
    var params = fullParamsFor(entry, this._lang);

    var itemIndex = ex._itemIndex;
    var applied = ex.apply(entry.action_name, params);
    var actionResult = ex.resultFor(entry.action_name, itemIndex);

    var step = {
      step_index: stepIndex,
      item_index: itemIndex,
      action_name: entry.action_name,
      params: U.deepCopy(params),
      menu_names: ser.menu.map(function (e) { return e.action_name; }),
      menu_index: mapped.menuIndex,
      argmax_index: best,
      score: bestScore,
      from_model: true,
      action_id: applied.action_record.action_id,
      state_hash: applied.action_record.state_hash,
      result: actionResult,
      token_count: T,
      encoding_version: ENCODING_VERSION
    };
    if (entry.action_name === "run_check") this._runReports[itemIndex] = U.deepCopy(actionResult.report);
    if (entry.action_name === "export") this._exportRecords[itemIndex] = U.deepCopy(actionResult);
    this._steps.push(step);

    var terminal = null;
    if (ex._terminated) terminal = "aborted";
    else if (ex._flagOpen()) terminal = "flag_open";
    else if (ex._itemIndex >= ex._items.length) terminal = "complete";
    step.terminal = terminal;
    if (terminal) this._done = true;
    return step;
  };

  /* Done-heads: per-item completion predicates (domain contract 3). */
  Controller.prototype.doneHeads = function () {
    var ex = this._ex;
    if (!ex) return {};
    var heads = {};
    var self = this;
    ex._items.forEach(function (item, i) {
      heads[i] = self._donePredicate(i, item);
    });
    return heads;
  };

  Controller.prototype._donePredicate = function (i, item) {
    var ex = this._ex, p = item.params;
    switch (item.intent) {
      case "add_node":
      case "add_collection_point": {
        var n = ex._nodes[p.node_id];
        if (!n) return false;
        var wantType = item.intent === "add_collection_point" ? "collection" : p.type;
        return n.type === wantType &&
          U.roundHalfUp(n.x) === U.roundHalfUp(p.x) &&
          U.roundHalfUp(n.y) === U.roundHalfUp(p.y) &&
          n.label === p.label;
      }
      case "connect":
        return ex._edges.some(function (e) { return e.a === p.a && e.b === p.b && e.cat === p.cat; });
      case "set_field": {
        var nd = ex._nodes[p.node_id];
        if (!nd) return false;
        if (p.field === "label") return nd.label === p.value;
        return U.roundHalfUp(nd[p.field]) === U.roundHalfUp(p.value);
      }
      case "set_retention": {
        var ann = null;
        for (var k = 0; k < ex._annotations.length; k++) {
          var a = ex._annotations[k];
          if (a.kind === "retention" && a.node_id === p.node_id) { ann = a; break; }
        }
        if (!ann) return false;
        if (p.verify_only === true) return ann.payload.verify_only === true;
        return ann.payload.record_type === p.record_type &&
          ann.payload.range_min_years === p.range_min_years &&
          ann.payload.range_max_years === p.range_max_years &&
          ann.payload.statute === p.statute &&
          ann.payload.as_of === p.as_of;
      }
      case "confirm_node":
        return ex._annotations.some(function (a) {
          return a.kind === "confirmation" && a.node_id === p.node_id;
        });
      case "flag_for_review": {
        var flag = null;
        for (var f = 0; f < ex._annotations.length; f++) {
          var fl = ex._annotations[f];
          if (fl.kind !== "review_flag") continue;
          if (fl.payload.reason === p.reason) { flag = fl; break; }
        }
        /* Terminal states count as done: cleared flag with the item advanced. */
        if (flag) return true;
        return !!ex._done[i];
      }
      case "run_check": {
        var rep = this._runReports[i];
        if (!rep) return false;
        return p.checks.every(function (c) { return rep[c] && typeof rep[c].pass === "boolean"; });
      }
      case "export":
        return !!this._exportRecords[i] && Object.keys(ex._nodes).length >= 1;
      case "skip_recipe_item":
        return !!ex._skipped[i];
      case "undo_last": {
        /* The recorded undo names the undone action and tombstones its key. */
        return this._steps.some(function (s) {
          return s.item_index === i && s.action_name === "undo_last" &&
            s.result && s.result.undone_action && ex._tombstones[s.result.tombstoned_key];
        });
      }
      case "abort_session":
        return ex._terminated === true && !!ex._abortReason;
      default:
        return false;
    }
  };

  Controller.prototype.state = function () {
    if (!this._ex) return null;
    var ex = this._ex;
    return {
      session_id: this._sessionId,
      recipe_id: ex._recipeId,
      item_index: ex._itemIndex,
      items: ex._items.length,
      nodes: U.deepCopy(ex._nodes),
      edges: U.deepCopy(ex._edges),
      annotations: U.deepCopy(ex._annotations),
      terminated: ex._terminated,
      abort_reason: ex._abortReason,
      flag_open: ex._flagOpen(),
      state_hash: ex.stateHash(),
      steps: this._steps.length,
      done: this._done
    };
  };

  Controller.prototype.trace = function () {
    return {
      session_id: this._sessionId,
      recipe_id: this._recipe ? this._recipe.recipe_id : null,
      encoding_version: ENCODING_VERSION,
      steps: this._steps.map(function (s) {
        return {
          step_index: s.step_index,
          item_index: s.item_index,
          action_name: s.action_name,
          params: s.params,
          menu_index: s.menu_index,
          menu_names: s.menu_names,
          score: s.score,
          from_model: s.from_model,
          terminal: s.terminal || null
        };
      }),
      done_heads: this.doneHeads()
    };
  };

  Controller.prototype.reset = function () {
    this._ex = null;
    this._recipe = null;
    this._steps = [];
    this._runReports = {};
    this._exportRecords = {};
    this._sessionId = null;
    this._running = false;
    this._done = false;
  };

  /* ------------------------------------------------------------------ */
  /* Test hooks                                                          */
  /* ------------------------------------------------------------------ */
  var controller = new Controller();

  var hooks = {
    ready: ready,
    start: function (recipe) { return controller.start(recipe); },
    stepOnce: function () { return controller.stepOnce(); },
    runAll: async function (opts) {
      opts = opts || {};
      var paceMs = opts.paceMs || 0;
      var maxSteps = opts.maxSteps || MAX_STEPS;
      var last = null;
      while (controller._steps.length < maxSteps) {
        last = await controller.stepOnce();
        if (opts.onStep) await opts.onStep(last);
        if (last.terminal) break;
        if (paceMs > 0) await new Promise(function (r) { setTimeout(r, paceMs); });
      }
      return controller.trace();
    },
    abort: function (reason, lang) {
      var ex = controller.executor();
      if (!ex) throw new Error("no session started.");
      return ex.apply("abort_session", { reason: reason || CANNED[lang || controller.lang()].abort });
    },
    clearFlagAndContinue: function () {
      var ex = controller.executor();
      if (!ex) throw new Error("no session started.");
      return ex.clearFlagsOutOfBand();
    },
    recordConfirmation: function (node_id, note) {
      var ex = controller.executor();
      if (!ex) throw new Error("no session started.");
      return ex.recordConfirmationOutOfBand(node_id, note || "", ex._itemIndex);
    },
    applyCorrection: function (op) {
      var ex = controller.executor();
      if (!ex) throw new Error("no session started.");
      return ex.applyCorrection(op);
    },
    setLang: function (lang) { controller.setLang(lang); },
    state: function () { return controller.state(); },
    trace: function () { return controller.trace(); },
    reset: function () { controller.reset(); },
    controller: controller,
    ENCODING_VERSION: ENCODING_VERSION,
    MODEL_SHA256: MODEL_SHA256
  };

  return {
    Controller: Controller,
    ready: ready,
    hooks: hooks,
    controller: controller,
    serializeStep: serializeStep,
    vendorUrl: vendorUrl,
    CANNED: CANNED
  };
});
