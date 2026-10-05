/**
 * ui.js - the Assistant UI: 4-chip intake, narrated build, review loop,
 * draft Excel download, trust counter, one-click wipe.
 *
 * Flow: intake (4 chips, zero typing) -> model run (step log narrates every
 * action, canvas choreography) -> review loop (node-by-node one-tap
 * approve/fix) -> draft Excel download -> wipe. Everything runs in the
 * browser; nothing is sent anywhere (live counter proves it).
 *
 * Depends on (load order): net-guard.js, s1tokenize.js, s1util.js, menu.js,
 * apply.js, narrate.js, templates.js, review.js, exporter.js, i18n.js,
 * executor.js. Exposes window.S1UI.init({rootId, lang}).
 * No em dashes.
 */
(function (root, factory) {
  "use strict";
  var api = factory(root.S1Templates, root.S1Narrate, root.S1Review, root.S1Exporter, root.S1I18n, root.S1Executor);
  if (typeof module === "object" && module !== null && typeof module.exports === "object") {
    module.exports = api;
  } else {
    root.S1UI = api;
  }
})(typeof self !== "undefined" ? self : this, function (Tmpl, Narr, Rev, Exp, I18n, Exec) {
  "use strict";

  var root = (typeof window !== "undefined") ? window : (typeof self !== "undefined" ? self : this);

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== null && text !== undefined) n.textContent = text;
    return n;
  }

  function init(opts) {
    opts = opts || {};
    var lang = opts.lang === "fr" ? "fr" : "en";
    var S = I18n.strings(lang);
    var H = Exec.hooks;
    H.setLang(lang);

    var host = $(opts.rootId || "s1-assistant");
    if (!host) return null;

    var state = {
      chips: { size: null, sector: null, region: null, types: null },
      template: null,
      running: false,
      stopRequested: false,
      checklist: [],
      confirmations: [],
      corrections: [],
      reviewed: false
    };

    /* ---------------- trust bar ---------------- */
    var trustBar = el("div", "s1-trust");
    var netCount = el("strong", "s1-netcount", "0");
    netCount.id = "s1-netcount";
    trustBar.appendChild(netCount);
    trustBar.appendChild(el("span", null, " " + S.requestsSent + ". "));
    trustBar.appendChild(el("span", "s1-trustcopy", S.trustCopy));
    var draftBadge = el("span", "s1-draftbadge", S.draftBadge);
    trustBar.appendChild(draftBadge);

    function refreshNet() {
      netCount.textContent = String(root.__s1net ? root.__s1net.count() : 0);
    }
    setInterval(refreshNet, 1000);
    refreshNet();

    /* ---------------- intake ---------------- */
    var intake = el("div", "s1-intake");
    var h2 = el("h2", "s1-title", S.entryTitle);
    h2.tabIndex = -1;
    intake.appendChild(h2);
    intake.appendChild(el("p", "s1-lede", S.entryBody));

    var chipWrap = el("div", "s1-chips");
    var chipInputs = {};
    Tmpl.CHIPS.forEach(function (chip) {
      var group = el("fieldset", "s1-chipgroup");
      var legend = el("legend", "s1-chipname", S["chip" + chip.id[0].toUpperCase() + chip.id.slice(1)]);
      group.appendChild(legend);
      var opts = el("div", "s1-chipoptions");
      opts.setAttribute("role", "radiogroup");
      opts.setAttribute("aria-label", legend.textContent);
      chip.options.forEach(function (opt) {
        var label = el("label", "s1-chip");
        var input = document.createElement("input");
        input.type = "radio";
        input.name = "s1-chip-" + chip.id;
        input.value = opt;
        var optLabel = chip.id === "size" ? opt : (S[chip.id + "Names"] || {})[opt] || opt;
        label.appendChild(input);
        label.appendChild(el("span", null, optLabel));
        input.addEventListener("change", function () {
          state.chips[chip.id] = opt;
          resolveTemplate();
        });
        opts.appendChild(label);
      });
      chipInputs[chip.id] = opts;
      group.appendChild(opts);
      chipWrap.appendChild(group);
    });
    intake.appendChild(chipWrap);

    var templateBox = el("div", "s1-templatebox");
    intake.appendChild(templateBox);

    function resolveTemplate() {
      while (templateBox.firstChild) templateBox.removeChild(templateBox.firstChild);
      state.template = null;
      var problems = Tmpl.validateChips(state.chips);
      if (problems.length) return; /* still choosing */
      var t = Tmpl.selectTemplate(state.chips);
      if (t) {
        state.template = t;
        var p = el("p", "s1-templateok", t.name + " (" + t.items.length + " steps)");
        templateBox.appendChild(p);
        var go = el("button", "btn s1-go", S.startRun);
        go.type = "button";
        go.addEventListener("click", startRun);
        templateBox.appendChild(go);
        go.focus();
      } else {
        templateBox.appendChild(el("p", "s1-templatemissing", S.templateMissing));
        var listTitle = el("p", "s1-readytitle", S.readyTemplates + ":");
        templateBox.appendChild(listTitle);
        Tmpl.authoredTemplates().forEach(function (a) {
          var b = el("button", "btn secondary s1-tmplpick", a.name);
          b.type = "button";
          b.addEventListener("click", function () {
            Object.keys(a.chips).forEach(function (cid) {
              state.chips[cid] = a.chips[cid];
              var radios = chipInputs[cid].querySelectorAll("input");
              for (var i = 0; i < radios.length; i++) {
                radios[i].checked = (radios[i].value === a.chips[cid]);
              }
            });
            resolveTemplate();
          });
          templateBox.appendChild(b);
        });
      }
    }

    /* ---------------- run ---------------- */
    var runBox = el("div", "s1-run");
    runBox.hidden = true;
    var runHead = el("div", "s1-runhead");
    var logTitle = el("h3", "s1-logtitle", S.stepLogTitle);
    logTitle.tabIndex = -1;
    runHead.appendChild(logTitle);
    var stopBtn = el("button", "btn secondary s1-stop", S.stop);
    stopBtn.type = "button";
    stopBtn.addEventListener("click", function () {
      state.stopRequested = true;
      stopBtn.disabled = true;
    });
    runHead.appendChild(stopBtn);
    runBox.appendChild(runHead);
    var statusLine = el("p", "s1-status", "");
    statusLine.setAttribute("role", "status");
    runBox.appendChild(statusLine);
    var stepLog = el("ol", "s1-steplog");
    stepLog.setAttribute("aria-live", "polite");
    runBox.appendChild(stepLog);
    var flagBox = el("div", "s1-flagbox");
    flagBox.hidden = true;
    runBox.appendChild(flagBox);

    function canvasState() {
      var st = H.state();
      return { nodes: st.nodes, edges: st.edges };
    }

    function paintCanvas() {
      try {
        if (root.DMImport && typeof root.DMImport.applyState === "function") {
          root.DMImport.applyState(canvasState());
        }
      } catch (e) { /* canvas is best-effort choreography */ }
    }

    function bloom(nodeId) {
      try {
        var n = document.querySelector('[data-node="' + nodeId + '"]');
        if (n) {
          n.classList.add("s1-bloom");
          setTimeout(function () { n.classList.remove("s1-bloom"); }, 1200);
        }
        var edges = document.querySelectorAll("#dm-viewport .edge");
        if (edges.length) {
          var last = edges[edges.length - 1];
          last.classList.add("s1-bloom-edge");
          setTimeout(function () { last.classList.remove("s1-bloom-edge"); }, 1200);
        }
      } catch (e) { /* ignore */ }
    }

    function narrateStep(step) {
      var ex = H.controller.executor();
      var ctx = {};
      var p = step.params;
      if (step.action_name === "add_node" || step.action_name === "add_collection_point") {
        ctx.label = p.label;
        bloom(p.node_id);
      } else if (step.action_name === "connect") {
        ctx.a_label = ex._nodes[p.a] ? ex._nodes[p.a].label : p.a;
        ctx.b_label = ex._nodes[p.b] ? ex._nodes[p.b].label : p.b;
        bloom(p.b);
      } else if (step.action_name === "set_field") {
        ctx.label = ex._nodes[p.node_id] ? ex._nodes[p.node_id].label : p.node_id;
      } else if (step.action_name === "set_retention") {
        ctx.label = ex._nodes[p.node_id] ? ex._nodes[p.node_id].label : p.node_id;
      } else if (step.action_name === "confirm_node") {
        ctx.label = ex._nodes[p.node_id] ? ex._nodes[p.node_id].label : p.node_id;
      } else if (step.action_name === "flag_for_review") {
        ctx.target = p.node_id
          ? (ex._nodes[p.node_id] ? ex._nodes[p.node_id].label : p.node_id)
          : (lang === "fr" ? "l'étape " + step.item_index : "step " + step.item_index);
      } else if (step.action_name === "undo_last") {
        ctx.detail = step.result && step.result.undone_action_id
          ? ((lang === "fr" ? "inversion de " : "reversed ") + step.result.undone_action_id)
          : "";
      }
      var texts = Narr.narrate(step.action_name, p, step.result, ctx);
      return lang === "fr" ? texts.fr : texts.en;
    }

    function logStep(text, cls) {
      var li = el("li", "s1-step" + (cls ? " " + cls : ""), text);
      stepLog.appendChild(li);
      li.scrollIntoView({ block: "nearest" });
      return li;
    }

    async function startRun() {
      if (state.running || !state.template) return;
      state.running = true;
      state.stopRequested = false;
      intake.hidden = true;
      runBox.hidden = false;
      reviewBox.hidden = true;
      doneBox.hidden = true;
      logTitle.focus();
      statusLine.textContent = S.loadingModel;
      try {
        await H.ready();
      } catch (e) {
        statusLine.textContent = String((e && e.message) || e);
        state.running = false;
        return;
      }
      statusLine.textContent = S.modelReady;
      H.start(state.template);
      paintCanvas();
      refreshNet();

      var aborted = false;
      while (!aborted) {
        if (state.stopRequested) {
          try {
            var ab = H.abort(null, lang);
            var abTexts = Narr.narrate("abort_session", { reason: ab.reason || "" }, null, {});
            logStep(lang === "fr" ? abTexts.fr : abTexts.en, "s1-aborted");
          } catch (e) { /* already terminated */ }
          statusLine.textContent = S.stopped;
          aborted = true;
          break;
        }
        var step;
        try {
          step = await H.stepOnce();
        } catch (e) {
          logStep(String((e && e.message) || e), "s1-error");
          statusLine.textContent = String((e && e.message) || e);
          aborted = true;
          break;
        }
        paintCanvas();
        logStep(narrateStep(step));
        refreshNet();
        if (step.terminal === "flag_open") {
          await pauseOnFlag();
          continue;
        }
        if (step.terminal === "aborted") {
          statusLine.textContent = S.stopped;
          aborted = true;
          break;
        }
        if (step.terminal === "complete") break;
        await new Promise(function (r) { setTimeout(r, 550); });
      }
      state.running = false;
      stopBtn.disabled = false;
      if (!aborted) openReview();
      else paintCanvas();
    }

    function pauseOnFlag() {
      return new Promise(function (resolve) {
        while (flagBox.firstChild) flagBox.removeChild(flagBox.firstChild);
        flagBox.hidden = false;
        flagBox.appendChild(el("p", "s1-flagmsg", S.flagPaused));
        var btn = el("button", "btn s1-clearflag", S.clearFlag);
        btn.type = "button";
        btn.addEventListener("click", function () {
          H.clearFlagAndContinue();
          flagBox.hidden = true;
          paintCanvas();
          resolve();
        });
        flagBox.appendChild(btn);
        btn.focus();
        statusLine.textContent = S.flagPaused;
      });
    }

    /* ---------------- review ---------------- */
    var reviewBox = el("div", "s1-review");
    reviewBox.hidden = true;
    var reviewTitle = el("h3", "s1-reviewtitle", S.reviewTitle);
    reviewTitle.tabIndex = -1;
    reviewBox.appendChild(reviewTitle);
    reviewBox.appendChild(el("p", "s1-reviewlede", S.reviewLede));
    var reviewList = el("div", "s1-reviewlist");
    reviewBox.appendChild(reviewList);

    function openReview() {
      var ex = H.controller.executor();
      state.checklist = Rev.deriveChecklist(ex);
      state.confirmations = [];
      state.reviewed = false;
      while (reviewList.firstChild) reviewList.removeChild(reviewList.firstChild);
      runBox.hidden = true;
      doneBox.hidden = true;
      reviewBox.hidden = false;
      statusLine.textContent = S.runComplete;
      state.checklist.forEach(function (row, i) { renderReviewRow(row, i); });
      reviewTitle.focus();
      paintCanvas();
    }

    function renderReviewRow(row, i) {
      var ex = H.controller.executor();
      var item = el("div", "s1-reviewrow");
      item.id = "s1-reviewrow-" + i;
      var prompt = Narr.reviewPrompt(row.kind, reviewPromptCtx(ex, row), lang);
      item.appendChild(el("p", "s1-reviewprompt", prompt));
      var status = el("p", "s1-rowstatus " + row.status, S[row.status] || row.status);
      item.appendChild(status);
      var btnRow = el("div", "s1-rowbtns");
      var confirmBtn = el("button", "btn s1-confirm", S.confirm);
      confirmBtn.type = "button";
      var fixBtn = el("button", "btn secondary s1-fix", S.fix);
      fixBtn.type = "button";
      confirmBtn.addEventListener("click", function () { confirmRow(row, i, null); });
      fixBtn.addEventListener("click", function () { openFixPanel(item, row, i); });
      btnRow.appendChild(confirmBtn);
      btnRow.appendChild(fixBtn);
      item.appendChild(btnRow);
      reviewList.appendChild(item);
      row._el = item;
      row._statusEl = status;
      row._btnRow = btnRow;
    }

    function reviewPromptCtx(ex, row) {
      if (row.kind === "node") return { label: row.label, type: row.detail.type };
      if (row.kind === "edge") {
        return {
          cat: row.cat,
          a_label: ex._nodes[row.a] ? ex._nodes[row.a].label : row.a,
          b_label: ex._nodes[row.b] ? ex._nodes[row.b].label : row.b
        };
      }
      return { label: row.label };
    }

    function confirmRow(row, i, note) {
      var ex = H.controller.executor();
      var st = H.state();
      if (row.kind === "node") {
        H.recordConfirmation(row.node_id, note || "");
      }
      var rec = Rev.confirmationRecord(st.session_id, st.recipe_id, st.item_index, row.ref, row.label, note || "");
      state.confirmations.push(rec);
      row.status = "confirmed";
      row._statusEl.textContent = S.confirmed;
      row._statusEl.className = "s1-rowstatus confirmed";
      row._btnRow.hidden = true;
      maybeFinishReview();
    }

    function logCorrection(op, ref, before, after) {
      var st = H.state();
      state.corrections.push(Rev.correctionLine(st.session_id, st.recipe_id, op, ref, before, after));
    }

    function openFixPanel(item, row, i) {
      var ex = H.controller.executor();
      var old = item.querySelector(".s1-fixpanel");
      if (old) { old.remove(); return; }
      var panel = el("div", "s1-fixpanel");
      function addBtn(text, fn) {
        var b = el("button", "btn secondary s1-fixopt", text);
        b.type = "button";
        b.addEventListener("click", fn);
        panel.appendChild(b);
        return b;
      }
      function doneFix(opName, op, confirmKind, ctx) {
        var res = H.applyCorrection(op);
        logCorrection(opName, row.ref, res.before, res.after);
        refreshReviewRow(row, ex, item);
        paintCanvas();
        var msg = Narr.correctionConfirm(confirmKind, ctx || {}, lang);
        logStep(msg, "s1-corrected");
        confirmRow(row, i, null);
      }
      /* After a correction mutates the executor, re-derive the affected
         checklist row so the exported Review sheet describes the corrected
         state, not the pre-fix state. Rows for removed artifacts keep a
         marker so the sheet stays honest instead of stale. */
      function refreshReviewRow(row, ex, item) {
        var fresh = Rev.deriveChecklist(ex), k;
        for (k = 0; k < fresh.length; k++) {
          if (fresh[k].ref === row.ref) {
            row.label = fresh[k].label;
            row.detail = fresh[k].detail;
            row.removed = false;
            if (fresh[k].kind === "edge") { row.a = fresh[k].a; row.b = fresh[k].b; row.cat = fresh[k].cat; }
            if (fresh[k].kind === "node") { row.node_id = fresh[k].node_id; }
            break;
          }
        }
        if (k === fresh.length) row.removed = true;
        if (item) {
          var p = item.querySelector(".s1-reviewprompt");
          if (p && !row.removed) p.textContent = Narr.reviewPrompt(row.kind, reviewPromptCtx(ex, row), lang);
        }
      }
      if (row.kind === "node") {
        var lab = el("label", "s1-fixlabel", S.newLabel + ": ");
        var inp = document.createElement("input");
        inp.type = "text";
        inp.maxLength = 200;
        inp.value = row.label;
        inp.setAttribute("aria-label", S.newLabel);
        lab.appendChild(inp);
        panel.appendChild(lab);
        addBtn(S.fixRelabel, function () {
          var v = inp.value.trim();
          if (!v) { inp.focus(); return; }
          doneFix("relabel", { op: "relabel", node_id: row.node_id, label: v }, "relabel", { label: v });
        });
        var typeNames = lang === "fr"
          ? { collection: "Point de collecte", system: "Système", thirdparty: "Tiers", destruction: "Destruction" }
          : { collection: "Collection point", system: "System", thirdparty: "Third party", destruction: "Destruction" };
        ["collection", "system", "thirdparty", "destruction"].forEach(function (t) {
          addBtn(typeNames[t], function () {
            doneFix("retype", { op: "retype", node_id: row.node_id, type: t }, "retype",
              { label: ex._nodes[row.node_id].label, type: t });
          });
        });
        addBtn(S.fixRemove, function () {
          doneFix("remove_node", { op: "remove_node", node_id: row.node_id }, "relabel", { label: row.label });
          row._el.hidden = true;
        });
      } else if (row.kind === "edge") {
        ["contact", "payment", "marketing"].forEach(function (c) {
          addBtn(c, function () {
            doneFix("reconnect", { op: "reconnect", a: row.a, b: row.b, cat: c }, "reconnect",
              { b_label: ex._nodes[row.b] ? ex._nodes[row.b].label : row.b });
          });
        });
        addBtn(S.fixRemove, function () {
          var res = H.applyCorrection({ op: "remove_edge", a: row.a, b: row.b });
          logCorrection("remove_edge", row.ref, res.before, res.after);
          refreshReviewRow(row, ex, item);
          paintCanvas();
          row._el.hidden = true;
          maybeFinishReview();
        });
      } else if (row.kind === "retention") {
        addBtn(S.fixVerify, function () {
          var res = H.applyCorrection({ op: "verify_only", node_id: row.node_id });
          logCorrection("verify_only", row.ref, res.before, res.after);
          refreshReviewRow(row, ex, item);
          paintCanvas();
          confirmRow(row, i, null);
        });
      }
      var cancel = el("button", "btn secondary s1-fixcancel", S.fixCancel);
      cancel.type = "button";
      cancel.addEventListener("click", function () { panel.remove(); });
      panel.appendChild(cancel);
      item.appendChild(panel);
      var first = panel.querySelector("input, button");
      if (first) first.focus();
    }

    function maybeFinishReview() {
      var pending = state.checklist.filter(function (r) { return r.status !== "confirmed" && !r._el.hidden; });
      if (pending.length === 0 && !state.reviewed) {
        state.reviewed = true;
        openDone();
      } else if (pending.length > 0) {
        var next = pending[0];
        var btn = next._el.querySelector(".s1-confirm");
        if (btn) btn.focus();
      }
    }

    /* ---------------- done: downloads + wipe ---------------- */
    var doneBox = el("div", "s1-done");
    doneBox.hidden = true;
    var doneTitle = el("h3", "s1-donetitle", S.reviewDone);
    doneTitle.tabIndex = -1;
    doneBox.appendChild(doneTitle);
    var dlRow = el("div", "s1-dlrow");
    var dlBtn = el("button", "btn s1-download", S.downloadExcel);
    dlBtn.type = "button";
    dlBtn.addEventListener("click", downloadExcel);
    var corrBtn = el("button", "btn secondary s1-corr", S.downloadCorrections);
    corrBtn.type = "button";
    corrBtn.addEventListener("click", downloadCorrections);
    var wipeBtn = el("button", "btn secondary s1-wipe", S.wipe);
    wipeBtn.type = "button";
    wipeBtn.addEventListener("click", wipe);
    dlRow.appendChild(dlBtn);
    dlRow.appendChild(corrBtn);
    dlRow.appendChild(wipeBtn);
    doneBox.appendChild(dlRow);

    function downloadBlob(bytes, filename, mime) {
      var blob = new Blob([bytes], { type: mime });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 4000);
    }

    function downloadExcel() {
      var st = H.state();
      var xml = Exp.buildDraftWorkbook(
        { nodes: st.nodes, edges: st.edges },
        state.checklist, state.confirmations, lang);
      var bytes = new Uint8Array(BufferSafe(xml));
      downloadBlob(bytes, "data-map-inventory.xls", "application/vnd.ms-excel");
    }

    function BufferSafe(xml) {
      if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(xml);
      var out = [], i, cp;
      for (i = 0; i < xml.length; i++) {
        cp = xml.codePointAt(i);
        if (cp > 0xffff) i++;
        if (cp < 0x80) out.push(cp);
        else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
        else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      }
      return new Uint8Array(out);
    }

    function downloadCorrections() {
      var lines = state.corrections.map(function (c) { return JSON.stringify(c); }).join("\n");
      if (!lines) lines = JSON.stringify({ note: S.correctionsNone });
      downloadBlob(BufferSafe(lines + "\n"), "corrections.jsonl", "application/json");
    }

    function wipe() {
      if (!window.confirm(S.wipeConfirm)) return;
      H.reset();
      state.chips = { size: null, sector: null, region: null, types: null };
      state.template = null;
      state.checklist = [];
      state.confirmations = [];
      state.corrections = [];
      state.reviewed = false;
      state.running = false;
      state.stopRequested = false;
      Object.keys(chipInputs).forEach(function (cid) {
        var radios = chipInputs[cid].querySelectorAll("input");
        for (var i = 0; i < radios.length; i++) radios[i].checked = false;
      });
      while (templateBox.firstChild) templateBox.removeChild(templateBox.firstChild);
      while (stepLog.firstChild) stepLog.removeChild(stepLog.firstChild);
      while (reviewList.firstChild) reviewList.removeChild(reviewList.firstChild);
      flagBox.hidden = true;
      statusLine.textContent = S.wipeDone;
      runBox.hidden = true;
      reviewBox.hidden = true;
      doneBox.hidden = true;
      intake.hidden = false;
      try {
        if (root.DMImport && typeof root.DMImport.applyState === "function") {
          root.DMImport.applyState({ nodes: {}, edges: [] });
        }
      } catch (e) { /* ignore */ }
      h2.focus();
      refreshNet();
    }

    function openDone() {
      reviewBox.hidden = true;
      doneBox.hidden = false;
      doneTitle.focus();
    }

    host.appendChild(trustBar);
    host.appendChild(intake);
    host.appendChild(runBox);
    host.appendChild(reviewBox);
    host.appendChild(doneBox);

    /* Chatbot handoff (Phase 7): the conversational panel authors the
       recipe and narrates the run; when the run completes it hands the
       live session to this existing review/export/wipe UI. */
    function enterReview() {
      if (state.running) return false;
      if (!H.controller.executor()) return false;
      intake.hidden = true;
      runBox.hidden = true;
      doneBox.hidden = true;
      openReview();
      return true;
    }

    return {
      state: state,
      startRun: startRun,
      wipe: wipe,
      refreshNet: refreshNet,
      enterReview: enterReview
    };
  }

  return { init: init };
});
