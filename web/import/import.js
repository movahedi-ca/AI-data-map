/* import.js - Phase 1 spreadsheet import UI for the data mapping guide.
 *
 * Classic script, no framework. Load order (before this file):
 *   import/engine/engine-bundle.js  -> window.DMEngine
 *   import/worker/worker-client.js  -> window.ImportClient
 * Strings live in window.T.import (EN/FR per page).
 *
 * The built map is applied through window.DMImport.applyState (the
 * builder.js hook, guide spec 1.1.0). All parsing runs in a Web Worker;
 * nothing is uploaded anywhere. Every inferred value is shown as a
 * suggestion until the visitor confirms it; validation flags are shown
 * inline and never auto-fixed.
 */
(function () {
  "use strict";

  /* B1 fix: document.currentScript is only valid during script evaluation.
     workerUrl() used to read it lazily from the file-input change handler,
     where it is always null, so the worker URL fell back to a page-relative
     path and 404d on any page not sitting next to an import/ directory.
     Capture the script URL once, up front. */
  var SCRIPT_SRC = "";
  try {
    var _cs = document.currentScript;
    if (_cs && _cs.src) SCRIPT_SRC = _cs.src;
  } catch (e) { /* older browsers: fall through to the page-relative fallback */ }

  var T = (window.T && window.T.import) || {};
  var E = window.DMEngine;
  var IC = window.ImportClient;

  function t(key, fallback) {
    return T[key] != null ? T[key] : fallback;
  }

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var sec = $("imp-sec");
  if (!sec || !E || !IC) return;

  var SYSTEMS_KINDS = { "template-systems": 1, "exporter-nodes": 1 };
  var FLOWS_KINDS = { "template-flows": 1, "exporter-connections": 1 };
  var EDGE_CATS = { contact: 1, payment: 1, marketing: 1 };

  var STEPS = ["imp-step-file", "imp-step-sheets", "imp-step-map", "imp-step-review", "imp-step-done"];
  function showStep(id) {
    STEPS.forEach(function (s) { $(s).hidden = (s !== id); });
  }

  var S = freshState();
  function freshState() {
    return {
      sheets: [],       // [{sheet, mapped}]
      sysIdx: -1,
      flowsIdx: -1,
      jobs: [],         // [{sheetIdx, kind, mapping, headerRow, confidence, skipMap}]
      model: null,      // {systems, flows, rejected}
      flags: [],
      catOf: {},        // flowIndex -> visitor-chosen category
      multiSheet: false,
      manifest: null    // dbt manifest adapter: {fileName, summary, tie, category}
    };
  }

  function setStatus(msg) { $("imp-status").textContent = msg || ""; }

  function workerUrl() {
    /* Resolve relative to this script's own directory, not the page URL:
       the demo pages live at web/canvas/ while the worker ships at
       web/import/worker/import-worker.js. */
    try { return new URL("worker/import-worker.js", SCRIPT_SRC).toString(); }
    catch (e) { return "import/worker/import-worker.js"; }
  }

  function kindLabel(kind) {
    if (kind === "template-systems") return t("kindSystems", "systems template");
    if (kind === "template-flows") return t("kindFlows", "data flows template");
    if (kind === "exporter-nodes" || kind === "exporter-connections") return t("kindExporter", "this tool's Excel export");
    return t("kindUnknown", "not importable");
  }

  function fieldLabel(field) {
    var fields = T.fields || {};
    return fields[field] != null ? fields[field] : field;
  }

  function catOptions() {
    var out = [];
    var sel = $("bn-cat");
    if (sel && sel.options) {
      for (var i = 0; i < sel.options.length; i++) {
        out.push({ value: sel.options[i].value, text: sel.options[i].text });
      }
    }
    if (!out.length) {
      out = [
        { value: "contact", text: "Contact / identity" },
        { value: "payment", text: "Payment" },
        { value: "marketing", text: "Marketing / consent" }
      ];
    }
    return out;
  }

  function typeLabel(typeEnum) {
    var sel = $("bn-type");
    if (sel && sel.options) {
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === typeEnum) return sel.options[i].text;
      }
    }
    return typeEnum;
  }

  /* ---------------- file intake ---------------- */

  function onFile(file) {
    if (!file) return;
    S = freshState();
    showStep("imp-step-file");
    setStatus(t("parsing", "Reading your file…"));
    IC.parseFile(file, workerUrl()).then(function (result) {
      setStatus("");
      if (result && !Array.isArray(result) && result.format === "manifest") {
        onManifest(file.name || "", result.manifest);
        return;
      }
      onSheets(result || []);
    }, function (err) {
      setStatus((err && err.message) || t("parseFail", "We could not read that file."));
    });
  }

  /* ---------------- dbt manifest adapter ----------------
   * MANIFEST-ADAPTER-CONTRACT.md section 7: the sheet picker and the
   * column mapping steps are skipped for manifests (C-8). The review
   * step shows the projection facts, the visitor names a release and
   * the tie is verified fail closed (section 9), and the visitor picks
   * one category for the whole import (C-6) before Build enables. */

  function onManifest(fileName, summary) {
    if (!summary || !summary.projection) {
      setStatus(t("parseFail", "We could not read that file."));
      return;
    }
    S.manifest = { fileName: fileName, summary: summary, tie: null, category: "" };
    renderManifestReview();
    showStep("imp-step-review");
  }

  function manifestRow(body, label, value) {
    var p = el("p", "imp-note");
    p.appendChild(el("strong", null, label + ": "));
    p.appendChild(document.createTextNode(value));
    body.appendChild(p);
  }

  function renderManifestReview() {
    var body = $("imp-review-body");
    body.innerHTML = "";
    var m = S.manifest;
    var s = m.summary;
    var counts = s.countsByType || {};

    body.appendChild(el("h4", null, t("manifestHead", "dbt manifest") + " (" + s.projection.counts.nodes + " " +
      t("manifestNodes", "nodes") + ", " + s.projection.counts.edges + " " + t("manifestEdges", "edges") + ")"));
    manifestRow(body, t("manifestFile", "File"), m.fileName);
    manifestRow(body, t("manifestSchema", "Manifest schema version"), s.schemaVersion);
    manifestRow(body, t("manifestDbt", "dbt version"), s.dbtVersion);
    manifestRow(body, t("manifestProject", "Project"), s.projectName);
    manifestRow(body, t("manifestByType", "Projected nodes by type"),
      "model " + (counts.model || 0) + ", seed " + (counts.seed || 0) +
      ", snapshot " + (counts.snapshot || 0) + ", test " + (counts.test || 0));
    manifestRow(body, t("manifestDropped", "Dropped dependency entries"), String(s.droppedEdges || 0));

    // Release tie (contract section 9): the visitor names a release ID.
    body.appendChild(el("h4", null, t("manifestReleaseHead", "Release tie")));
    var relField = el("div", "field");
    var relLabel = el("label", null, t("manifestRelease", "Release ID"));
    relLabel.setAttribute("for", "imp-rel-id");
    relField.appendChild(relLabel);
    var relInput = el("input");
    relInput.id = "imp-rel-id";
    relInput.setAttribute("type", "text");
    relInput.setAttribute("placeholder", "rel-YYYY-MM-DDTHH-MM-SSZ");
    relField.appendChild(relInput);
    body.appendChild(relField);
    var verifyBtn = el("button", "btn secondary", t("manifestVerify", "Verify release"));
    verifyBtn.setAttribute("type", "button");
    verifyBtn.id = "imp-rel-verify";
    body.appendChild(verifyBtn);
    var tieStatus = el("p", "imp-note", t("manifestTiePending", "Not verified yet. The map is drawn only after the release tie verifies."));
    tieStatus.id = "imp-rel-status";
    body.appendChild(tieStatus);
    verifyBtn.addEventListener("click", function () { runManifestTie(relInput.value); });

    // One category for the whole import (C-6), the visitor's choice.
    body.appendChild(el("h4", null, fieldLabel("category")));
    var catField = el("div", "field");
    var catSel = el("select");
    catSel.id = "imp-manifest-cat";
    catSel.setAttribute("aria-label", fieldLabel("category"));
    catSel.appendChild(el("option", null, t("chooseCat", "Choose…"))).value = "";
    catOptions().forEach(function (c) {
      var o = el("option", null, c.text);
      o.value = c.value;
      catSel.appendChild(o);
    });
    catSel.addEventListener("change", function () {
      S.manifest.category = catSel.value;
      updateBuildButton();
    });
    catField.appendChild(catSel);
    body.appendChild(catField);
    body.appendChild(el("p", "imp-note",
      t("manifestCatNote", "The category is your choice for the whole file. A dbt manifest carries no category, so none is taken from the file.")));

    updateBuildButton();
  }

  function runManifestTie(releaseId) {
    var status = $("imp-rel-status");
    var MT = window.ManifestTie;
    var MC = window.ManifestCore;
    if (!MT || !MC || typeof MT.verifyReleaseTie !== "function") {
      S.manifest.tie = null;
      if (status) status.textContent = t("manifestTieFail", "The release tie could not be verified. Nothing was drawn.");
      updateBuildButton();
      return;
    }
    if (status) status.textContent = t("manifestTieChecking", "Checking the release records…");
    MT.verifyReleaseTie({
      manifest: S.manifest.summary,
      releaseId: String(releaseId || "").replace(/^\s+|\s+$/g, ""),
      core: MC
    }).then(function (res) {
      if (res && res.ok) {
        S.manifest.tie = res;
        if (status) {
          status.textContent = t("manifestTieOk", "Release verified: ") + res.releaseId +
            (res.isCurrent
              ? " (" + t("manifestTieCurrent", "the current release") + ")"
              : " (" + t("manifestTieNotCurrent", "not the current release") + ")");
        }
      } else {
        S.manifest.tie = null;
        if (status) status.textContent = (res && res.error) || t("manifestTieFail", "The release tie could not be verified. Nothing was drawn.");
      }
      updateBuildButton();
    });
  }

  function onSheets(sheets) {
    // The template's EXAMPLE sheets stack the Systems and Data-flows sections
    // in one worksheet; split those into virtual sheets so each section maps
    // on its own headers instead of one section swallowing the other.
    var expanded = [];
    (sheets || []).forEach(function (sh) {
      E.splitSections(sh).forEach(function (part) { expanded.push(part); });
    });
    S.sheets = expanded.map(function (sh) { return { sheet: sh, mapped: E.mapColumns(sh) }; });
    var sysC = [], flowsC = [];
    S.sheets.forEach(function (sm, i) {
      if (SYSTEMS_KINDS[sm.mapped.kind]) sysC.push(i);
      if (FLOWS_KINDS[sm.mapped.kind]) flowsC.push(i);
    });
    if (!sysC.length) {
      setStatus(t("noSystems", "No systems sheet found in this file. Pick a file with a systems list and try again."));
      return;
    }
    S.multiSheet = S.sheets.length > 1;
    if (S.multiSheet) {
      buildSheetPicker(sysC, flowsC);
      showStep("imp-step-sheets");
    } else {
      S.sysIdx = sysC[0];
      S.flowsIdx = flowsC.length ? flowsC[0] : -1;
      startMapping();
    }
  }

  function buildSheetPicker(sysC, flowsC) {
    var sysSel = $("imp-sys-sheet"), flSel = $("imp-flows-sheet");
    sysSel.innerHTML = "";
    flSel.innerHTML = "";
    S.sheets.forEach(function (sm, i) {
      var m = sm.mapped;
      var label = sm.sheet.name + " (" + kindLabel(m.kind) + ", " +
        Math.round(m.confidence * 100) + "%)";
      var o1 = el("option", null, label);
      o1.value = String(i);
      if (!SYSTEMS_KINDS[m.kind]) o1.disabled = true;
      sysSel.appendChild(o1);
      var o2 = el("option", null, label);
      o2.value = String(i);
      if (!FLOWS_KINDS[m.kind]) o2.disabled = true;
      flSel.appendChild(o2);
    });
    var none = el("option", null, t("flowsNone", "None"));
    none.value = "";
    flSel.appendChild(none);
    sysSel.value = String(sysC[0]);
    flSel.value = flowsC.length ? String(flowsC[0]) : "";
  }

  /* ---------------- column mapping ---------------- */

  function startMapping() {
    S.jobs = [];
    [{ role: "sys", idx: S.sysIdx }, { role: "flows", idx: S.flowsIdx }].forEach(function (r) {
      if (r.idx < 0) return;
      var sm = S.sheets[r.idx];
      var m = sm.mapped;
      var skip = m.kind.indexOf("exporter-") === 0 && m.confidence === 1.0;
      S.jobs.push({
        role: r.role, sheetIdx: r.idx, kind: m.kind,
        mapping: Object.assign({}, m.mapping),
        headerRow: m.headerRow, confidence: m.confidence,
        skipMap: skip
      });
    });
    var needMap = S.jobs.some(function (j) { return !j.skipMap; });
    if (!needMap) {
      buildModel();
      renderReview();
      showStep("imp-step-review");
      return;
    }
    renderMapping();
    showStep("imp-step-map");
  }

  function headerCells(job) {
    var sm = S.sheets[job.sheetIdx];
    var row = (sm.sheet.rows[job.headerRow] || []);
    return row.map(function (c) { return String(c == null ? "" : c); });
  }

  function renderMapping() {
    var body = $("imp-map-body");
    body.innerHTML = "";
    S.jobs.forEach(function (job, ji) {
      if (job.skipMap) return;
      var sm = S.sheets[job.sheetIdx];
      var wrap = el("div", "imp-map-sheet");
      var h = el("h4", null, sm.sheet.name + " (" + kindLabel(job.kind) + ", " +
        t("confidence", "match confidence") + " " + Math.round(job.confidence * 100) + "%)");
      wrap.appendChild(h);
      var table = el("table", "imp-table");
      var headers = headerCells(job);
      E.COLUMN_SETS[job.kind].forEach(function (field) {
        var tr = el("tr");
        tr.appendChild(el("td", null, fieldLabel(field)));
        var td = el("td");
        var selEl = el("select");
        selEl.id = "imp-map-" + ji + "-" + field;
        selEl.setAttribute("aria-label", fieldLabel(field));
        var none = el("option", null, t("doNotUse", "Do not use"));
        none.value = "";
        selEl.appendChild(none);
        headers.forEach(function (hc, hi) {
          var o = el("option", null, hc === "" ? "(" + (hi + 1) + ")" : hc);
          o.value = String(hi);
          selEl.appendChild(o);
        });
        var guess = job.mapping[field];
        selEl.value = (guess === undefined || guess === null) ? "" : String(guess);
        td.appendChild(selEl);
        tr.appendChild(td);
        table.appendChild(tr);
      });
      wrap.appendChild(table);
      body.appendChild(wrap);
    });
  }

  function readMapping() {
    S.jobs.forEach(function (job, ji) {
      if (job.skipMap) return;
      var mapping = {};
      E.COLUMN_SETS[job.kind].forEach(function (field) {
        var selEl = $("imp-map-" + ji + "-" + field);
        if (selEl && selEl.value !== "") mapping[field] = parseInt(selEl.value, 10);
      });
      job.mapping = mapping;
    });
  }

  /* ---------------- review ---------------- */

  function buildModel() {
    var systems = [], flows = [], rejected = [];
    S.jobs.forEach(function (job) {
      var sm = S.sheets[job.sheetIdx];
      var cm = E.toCanonicalModel(
        { kind: job.kind, mapping: job.mapping, headerRow: job.headerRow },
        sm.sheet.rows
      );
      systems = systems.concat(cm.systems);
      flows = flows.concat(cm.flows);
      rejected = rejected.concat(cm.rejected);
    });
    S.model = { systems: systems, flows: flows, rejected: rejected };
    S.flags = E.validate(S.model);
  }

  function flagRow(flag, span) {
    var tr = el("tr");
    var td = el("td", "imp-flag imp-flag-" + flag.severity);
    td.setAttribute("colspan", String(span || 5));
    var sev = el("strong", null, (flag.severity === "error" ? t("error", "Error") : t("warning", "Warning")) + ": ");
    td.appendChild(sev);
    td.appendChild(document.createTextNode(flag.message));
    tr.appendChild(td);
    return tr;
  }

  function rawCategoryCell(flow, job) {
    var sm = S.sheets[job.sheetIdx];
    var idx = job.mapping.category;
    if (idx === undefined || idx === null) return "";
    var row = sm.sheet.rows[(flow.sourceRow || 1) - 1] || [];
    return String(row[idx] == null ? "" : row[idx]);
  }

  function renderReview() {
    var body = $("imp-review-body");
    body.innerHTML = "";
    var model = S.model;

    // Systems table.
    body.appendChild(el("h4", null, t("systemsHead", "Systems") + " (" + model.systems.length + ")"));
    var st = el("table", "imp-table");
    var stHead = el("tr");
    [fieldLabel("systemName"), fieldLabel("type"), t("row", "Row")].forEach(function (h) {
      stHead.appendChild(el("th", null, h));
    });
    st.appendChild(stHead);
    model.systems.forEach(function (s) {
      var tr = el("tr");
      tr.appendChild(el("td", null, s.name));
      tr.appendChild(el("td", null, typeLabel(s.type)));
      tr.appendChild(el("td", null, String(s.sourceRow || "")));
      st.appendChild(tr);
      S.flags.forEach(function (f) {
        if (f.row === s.sourceRow && (f.code === "LIKELY_DUPLICATE" || f.code === "INCONSISTENT_NAME")) {
          st.appendChild(flagRow(f, 3));
        }
      });
    });
    body.appendChild(st);

    // Flows table with per-flow category confirmation.
    var flowsJob = S.jobs.filter(function (j) { return j.role === "flows"; })[0] || null;
    body.appendChild(el("h4", null, t("flowsHead", "Data flows") + " (" + model.flows.length + ")"));
    var ft = el("table", "imp-table");
    var ftHead = el("tr");
    [fieldLabel("from"), fieldLabel("to"), fieldLabel("dataCategories"), t("row", "Row"),
     fieldLabel("category")].forEach(function (h) {
      ftHead.appendChild(el("th", null, h));
    });
    ft.appendChild(ftHead);
    var cats = catOptions();
    model.flows.forEach(function (f, i) {
      var tr = el("tr");
      tr.appendChild(el("td", null, f.from));
      tr.appendChild(el("td", null, f.to));
      tr.appendChild(el("td", null, f.dataCategories || ""));
      tr.appendChild(el("td", null, String(f.sourceRow || "")));
      var td = el("td");
      var selEl = el("select");
      selEl.id = "imp-cat-" + i;
      selEl.setAttribute("aria-label", fieldLabel("category") + ": " + f.from + " / " + f.to);
      selEl.appendChild(el("option", null, t("chooseCat", "Choose…"))).value = "";
      cats.forEach(function (c) {
        var o = el("option", null, c.text);
        o.value = c.value;
        selEl.appendChild(o);
      });

      // Prefill: the file's own category (exporter) is trusted input, not a
      // guess; a template flow carries an engine proposal marked as suggested.
      var badge = null, note = null;
      if (flowsJob && flowsJob.kind === "exporter-connections") {
        var resolved = E.mapCategoryDisplay(rawCategoryCell(f, flowsJob));
        if (EDGE_CATS[resolved]) {
          selEl.value = resolved;
          badge = el("span", "imp-badge imp-badge-file", t("fromFile", "From your file"));
        }
      } else if (f.proposedCategory && EDGE_CATS[f.proposedCategory.cat]) {
        selEl.value = f.proposedCategory.cat;
        badge = el("span", "imp-badge imp-badge-suggested", t("suggested", "Suggested"));
        note = el("div", "imp-note", f.proposedCategory.reason);
      }
      // A choice the visitor already made wins over any prefill.
      if (S.catOf[i]) selEl.value = S.catOf[i];
      (function (idx) {
        selEl.addEventListener("change", function () {
          S.catOf[idx] = selEl.value;
          updateBuildButton();
        });
      })(i);
      td.appendChild(selEl);
      if (badge) td.appendChild(badge);
      if (note) td.appendChild(note);
      tr.appendChild(td);
      ft.appendChild(tr);
      S.flags.forEach(function (fl) {
        if (fl.row === f.sourceRow && (fl.code === "DANGLING_REF" || fl.code === "MISSING_CATEGORY")) {
          ft.appendChild(flagRow(fl, 5));
        }
      });
    });
    body.appendChild(ft);

    // Skipped rows: rejected at parse/model time, listed with reasons.
    if (model.rejected.length) {
      body.appendChild(el("h4", null, t("skipped", "Skipped rows") + " (" + model.rejected.length + ")"));
      var ul = el("ul", "imp-skipped");
      model.rejected.forEach(function (r) {
        var li = el("li");
        var head = (r.row ? t("row", "Row") + " " + r.row + ": " : "");
        li.appendChild(el("strong", null, head));
        li.appendChild(document.createTextNode(r.reason || ""));
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }

    updateBuildButton();
  }

  function updateBuildButton() {
    var btn = $("imp-build");
    var note = $("imp-build-note");
    if (S.manifest) {
      // Manifest build gate (contract C-6, T-6): a verified release tie
      // and one visitor-chosen category are both required.
      var ready = !!(S.manifest.tie && S.manifest.tie.ok && EDGE_CATS[S.manifest.category]);
      btn.disabled = !ready;
      note.hidden = ready;
      if (!ready) {
        note.textContent = t("manifestBuildBlocked",
          "Verify the release tie and choose one category for the whole import before building the map.");
      }
      return;
    }
    var missing = S.model.flows.some(function (f, i) {
      var selEl = $("imp-cat-" + i);
      return !selEl || !selEl.value;
    });
    btn.disabled = missing;
    note.hidden = !missing;
    if (missing) note.textContent = t("buildBlocked", "Choose a category for every flow before building the map.");
  }

  /* ---------------- build ---------------- */

  function onBuild() {
    if (S.manifest) { onManifestBuild(); return; }
    var categories = {};
    S.model.flows.forEach(function (f, i) {
      var selEl = $("imp-cat-" + i);
      categories[i] = selEl ? selEl.value : "";
    });
    var result = E.buildState(S.model, { categories: categories });
    var hook = window.DMImport && window.DMImport.applyState;
    if (typeof hook !== "function") return;
    hook({ nodes: result.nodes, edges: result.edges, seq: result.seq });

    var skipped = S.model.rejected.concat(result.rejected || []);
    var done = $("imp-done-body");
    done.innerHTML = "";
    var counts = t("doneCounts", "{n} systems placed, {e} connections drawn, {s} rows skipped.")
      .replace("{n}", String(Object.keys(result.nodes).length))
      .replace("{e}", String(result.edges.length))
      .replace("{s}", String(skipped.length));
    done.appendChild(el("p", null, counts));
    done.appendChild(el("p", "imp-note", t("doneNote", "Warnings were kept as they were. Nothing was merged, renamed, or guessed beyond what you confirmed.")));
    if (skipped.length) {
      done.appendChild(el("h4", null, t("skipped", "Skipped rows") + " (" + skipped.length + ")"));
      var ul = el("ul", "imp-skipped");
      skipped.forEach(function (r) {
        var li = el("li");
        var head = "";
        if (r.row) head = t("row", "Row") + " " + r.row + ": ";
        else if (r.flow) head = (r.flow.from || "") + " / " + (r.flow.to || "") + ": ";
        li.appendChild(el("strong", null, head));
        li.appendChild(document.createTextNode(r.reason || ""));
        ul.appendChild(li);
      });
      done.appendChild(ul);
    }
    showStep("imp-step-done");
    var wrap = $("canvas-wrap");
    if (wrap && wrap.scrollIntoView) wrap.scrollIntoView();
  }

  function onManifestBuild() {
    var MC = window.ManifestCore;
    var hook = window.DMImport && window.DMImport.applyState;
    if (!MC || typeof hook !== "function") {
      // C-7: without the canvas hook nothing renders, and the UI says so.
      setStatus(t("manifestNoCanvas", "The map could not be placed on the canvas."));
      return;
    }
    var state;
    try {
      state = MC.buildCanvasState(S.manifest.summary.projection, S.manifest.category);
    } catch (e) {
      setStatus((e && e.message) || t("manifestNoCanvas", "The map could not be placed on the canvas."));
      return;
    }
    hook({ nodes: state.nodes, edges: state.edges, seq: state.seq });

    var done = $("imp-done-body");
    done.innerHTML = "";
    var counts = t("manifestDoneCounts", "{n} nodes placed, {e} connections drawn, {s} dependency entries dropped.")
      .replace("{n}", String(Object.keys(state.nodes).length))
      .replace("{e}", String(state.edges.length))
      .replace("{s}", String(S.manifest.summary.droppedEdges || 0));
    done.appendChild(el("p", null, counts));
    done.appendChild(el("p", "imp-note", t("manifestDoneNote",
      "The map shows the projection of the manifest for the verified release. The category on every connection is the one you chose for the whole file.")));
    showStep("imp-step-done");
    var wrap = $("canvas-wrap");
    if (wrap && wrap.scrollIntoView) wrap.scrollIntoView();
  }

  function resetAll() {
    S = freshState();
    var fi = $("imp-file");
    if (fi) fi.value = "";
    setStatus("");
    showStep("imp-step-file");
  }

  /* ---------------- wiring ---------------- */

  var drop = $("imp-drop"), fileIn = $("imp-file");
  if (drop && fileIn) {
    drop.addEventListener("dragover", function (e) {
      e.preventDefault();
      drop.classList.add("imp-over");
    });
    drop.addEventListener("dragleave", function () {
      drop.classList.remove("imp-over");
    });
    drop.addEventListener("drop", function (e) {
      e.preventDefault();
      drop.classList.remove("imp-over");
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onFile(f);
    });
    fileIn.addEventListener("change", function () {
      var f = fileIn.files && fileIn.files[0];
      if (f) onFile(f);
      fileIn.value = "";
    });
  }

  $("imp-sheets-next").addEventListener("click", function () {
    S.sysIdx = parseInt($("imp-sys-sheet").value, 10);
    var fv = $("imp-flows-sheet").value;
    S.flowsIdx = fv === "" ? -1 : parseInt(fv, 10);
    startMapping();
  });
  $("imp-sheets-back").addEventListener("click", function () {
    showStep("imp-step-file");
  });
  $("imp-map-next").addEventListener("click", function () {
    readMapping();
    buildModel();
    renderReview();
    showStep("imp-step-review");
  });
  $("imp-map-back").addEventListener("click", function () {
    showStep(S.multiSheet ? "imp-step-sheets" : "imp-step-file");
  });
  $("imp-review-back").addEventListener("click", function () {
    if (S.manifest) { showStep("imp-step-file"); return; }
    var needMap = S.jobs.some(function (j) { return !j.skipMap; });
    showStep(needMap ? "imp-step-map" : (S.multiSheet ? "imp-step-sheets" : "imp-step-file"));
  });
  $("imp-build").addEventListener("click", onBuild);
  $("imp-again").addEventListener("click", resetAll);

  showStep("imp-step-file");
})();
