/**
 * ui.js - the Assistant UI: one panel, two modes (quick 4-tap intake and
 * guided chat), narrated build, review loop, draft Excel download, trust
 * counter, one-click wipe.
 *
 * Flow: pick a mode (Quick setup: 4 chips, zero typing; Guided chat: four
 * questions in a chat, or a pasted recipe) -> model run (step log narrates
 * every action, canvas choreography) -> review loop (node-by-node one-tap
 * approve/fix) -> draft Excel download -> wipe. Everything runs in the
 * browser; nothing is sent anywhere (live counter proves it). The guided
 * chat is the chatbot module mounted embedded (embed:true) into the
 * panel's chat slot; the panel owns the single title, lede, and trust
 * line. The mode toggle locks while either mode has a run in progress so
 * a switch can never strand a live session.
 *
 * Depends on (load order): net-guard.js, s1tokenize.js, s1util.js, menu.js,
 * apply.js, narrate.js, templates.js, review.js, exporter.js, i18n.js,
 * executor.js, and (for the guided mode) chatbot.js. Exposes
 * window.S1UI.init({rootId, lang}).
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
    /* Stable styling hook: the panel CSS scopes to .s1-root (and the chat
       to .s1c-chat), never to the mount id, so the single panel keeps its
       styling whatever id the integrator mounts it on. */
    try { host.classList.add("s1-root"); } catch (e) { /* cosmetic */ }

    var state = {
      mode: "quick",
      chips: { size: null, sector: null, region: null, types: null },
      template: null,
      running: false,
      stopRequested: false,
      generation: 0,      /* bumped on every teardown so a stale run loop exits */
      flagResolve: null,  /* pending pauseOnFlag resolver, if any */
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

    /* All counter writes go through window.__s1net.setNetCount so the
       element always holds a plain count string from the first paint. */
    function refreshNet() {
      var api = root.__s1net;
      if (api && typeof api.setNetCount === "function") api.setNetCount(netCount);
      else netCount.textContent = "0";
    }
    setInterval(refreshNet, 1000);
    refreshNet();

    /* ---------------- single panel: title, mode toggle, mode panes ----------------
       One panel, one entry point. The quick 4-tap intake and the guided
       chat are two modes of the same assistant; the toggle switches which
       pane is visible. Native radio inputs: keyboard-operable with a
       browser-default visible focus ring. */
    var chatApi = null; /* chatbot handle once the guided pane is mounted */
    var modeWrap = el("div", "s1-modes");
    var panelTitle = el("h2", "s1-title", S.assistantTitle);
    panelTitle.tabIndex = -1;
    modeWrap.appendChild(panelTitle);
    modeWrap.appendChild(el("p", "s1-lede", S.assistantLede));

    var radioName = (opts.rootId || "s1-assistant") + "-mode";
    var modeBar = el("fieldset", "s1-modebar");
    modeBar.appendChild(el("legend", "s1-modelabel", S.modeLabel));
    var modeRadios = [];
    var modeLabels = [];
    [["quick", S.modeQuick, S.modeQuickDesc], ["guided", S.modeGuided, S.modeGuidedDesc]].forEach(function (m, i) {
      var label = el("label", "s1-mode");
      var radio = document.createElement("input");
      radio.type = "radio";
      radio.name = radioName;
      radio.value = m[0];
      radio.checked = i === 0;
      label.appendChild(radio);
      var txt = el("span", "s1-modetxt");
      txt.appendChild(el("strong", null, m[1]));
      txt.appendChild(el("span", "s1-modedesc", " " + m[2]));
      label.appendChild(txt);
      radio.addEventListener("change", function () { setMode(m[0]); });
      modeBar.appendChild(label);
      modeRadios.push(radio);
      modeLabels.push(label);
    });
    var modeNote = el("p", "s1-modenote", "");
    modeNote.setAttribute("role", "status");
    modeBar.appendChild(modeNote);
    modeWrap.appendChild(modeBar);

    var modePane = el("div", "s1-modepane");
    modeWrap.appendChild(modePane);

    function syncModeRadios() {
      modeRadios.forEach(function (r) { r.checked = (r.value === state.mode); });
    }

    /* A mode switch mid-run would strand a live session, so the toggle
       refuses while either mode has a run in progress and says why. */
    function setMode(mode) {
      if (state.mode !== mode) {
        if (state.running || (chatApi && chatApi.state.running)) {
          modeNote.textContent = S.chatBusy;
        } else {
          modeNote.textContent = "";
          state.mode = mode;
          quickPane.hidden = mode !== "quick";
          chatSlot.hidden = mode !== "guided";
          if (mode === "guided") {
            var f = chatSlot.querySelector("button");
            if (f) f.focus();
          } else {
            panelTitle.focus();
          }
        }
      }
      syncModeRadios();
    }

    function setModeLocked(locked) {
      modeRadios.forEach(function (r) { r.disabled = !!locked; });
    }

    /* ---------------- quick mode: 4-chip intake ---------------- */
    var quickPane = el("div", "s1-intake");
    modePane.appendChild(quickPane);

    var chatSlot = el("div", "s1-chatslot");
    chatSlot.id = (opts.rootId || "s1-assistant") + "-chat";
    chatSlot.hidden = true;
    modePane.appendChild(chatSlot);

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
    quickPane.appendChild(chipWrap);

    var templateBox = el("div", "s1-templatebox");
    quickPane.appendChild(templateBox);

    function templateSummary(t) {
      /* FR composes from the localized chip names (i18n.js templateName);
         the authored template names are English and must not leak into
         the FR path (2026-10-05). */
      var name = (lang === "fr") ? I18n.templateName(state.chips, "fr") : t.name;
      return name + " (" + t.items.length + " " + S.templateSteps + ")";
    }

    function resolveTemplate() {
      while (templateBox.firstChild) templateBox.removeChild(templateBox.firstChild);
      state.template = null;
      var problems = Tmpl.validateChips(state.chips);
      if (problems.length) return; /* still choosing */
      var t = Tmpl.selectTemplate(state.chips);
      if (t) {
        state.template = t;
        var p = el("p", "s1-templateok", templateSummary(t));
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
          var aname = (lang === "fr") ? I18n.templateName(a.chips, "fr") : a.name;
          var b = el("button", "btn secondary s1-tmplpick", aname);
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
    /* Recovery: visible in the Steps panel for both the quick 4-tap flow
       and the chatbot flow (shared panel). Tears the run down and restores
       the intake form to its initial state. Native button: keyboard-
       operable, and the site CSS gives it a visible focus ring. */
    var startOverBtn = el("button", "btn secondary s1-startover", S.startOver);
    startOverBtn.type = "button";
    startOverBtn.addEventListener("click", startOver);
    runHead.appendChild(startOverBtn);
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

    /* Paint the assistant's draft onto the real step-5 builder canvas via
       the window.DMImport seam (builder.js). The view (viewBox / pan /
       zoom) is captured before applyState and restored after, so painting
       never refits or jumps the user's zoom. When the T&C gate has not
       opened the canvas yet, DMImport queues the state and applies it on
       boot, so no step's output is lost. */
    function paintCanvas() {
      try {
        var DMI = root.DMImport;
        if (DMI && typeof DMI.applyState === "function") {
          var v = (typeof DMI.getView === "function") ? DMI.getView() : null;
          DMI.applyState(canvasState());
          if (v && typeof DMI.setView === "function") DMI.setView(v);
        }
      } catch (e) { /* canvas is best-effort choreography */ }
    }

    /* Bloom the just-added node on the builder canvas. Called AFTER
       paintCanvas: applyState re-renders the canvas, so blooming before
       would target detached elements. */
    function bloom(nodeId) {
      try {
        var n = document.querySelector('#builder-canvas [data-node="' + nodeId + '"]');
        if (n) {
          n.classList.add("s1-bloom");
          setTimeout(function () { n.classList.remove("s1-bloom"); }, 1200);
        }
        var edges = document.querySelectorAll("#builder-canvas .edge");
        if (edges.length) {
          var last = edges[edges.length - 1];
          last.classList.add("s1-bloom-edge");
          setTimeout(function () { last.classList.remove("s1-bloom-edge"); }, 1200);
        }
      } catch (e) { /* ignore */ }
    }

    function bloomForStep(step) {
      var p = step.params || {};
      if (step.action_name === "add_node" || step.action_name === "add_collection_point") {
        bloom(p.node_id);
      } else if (step.action_name === "connect") {
        bloom(p.b);
      }
    }

    function narrateStep(step) {
      var ex = H.controller.executor();
      var ctx = {};
      var p = step.params;
      if (step.action_name === "add_node" || step.action_name === "add_collection_point") {
        ctx.label = p.label;
      } else if (step.action_name === "connect") {
        ctx.a_label = ex._nodes[p.a] ? ex._nodes[p.a].label : p.a;
        ctx.b_label = ex._nodes[p.b] ? ex._nodes[p.b].label : p.b;
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
      li.style.setProperty("--s1-i", String(stepLog.children.length % 5));
      stepLog.appendChild(li);
      li.scrollIntoView({ block: "nearest" });
      pulseTrust();
      return li;
    }

    function pulseTrust() {
      try {
        trustBar.classList.remove("s1-pulse");
        void trustBar.offsetWidth;
        trustBar.classList.add("s1-pulse");
      } catch (e) { /* cosmetic only */ }
    }

    /* The run goes through the single page seam
       window.execute_mapping_workflow (workflow.js): ready, start, and the
       model step loop live there; this function owns the UI around it
       (status, step log, canvas paint + bloom, flag pause). */
    async function startRun() {
      if (state.running || !state.template) return;
      var wf = root.execute_mapping_workflow;
      if (typeof wf !== "function") {
        console.error("[s1] execute_mapping_workflow seam is not loaded.");
        statusLine.textContent = S.engineFailed;
        return;
      }
      state.running = true;
      state.stopRequested = false;
      state.generation++;
      var myGen = state.generation;
      setModeLocked(true);
      modeWrap.hidden = true;
      runBox.hidden = false;
      reviewBox.hidden = true;
      doneBox.hidden = true;
      logTitle.focus();
      statusLine.textContent = S.loadingModel;

      var res;
      try {
        res = await wf(state.template, {
          lang: lang,
          paceMs: 550,
          isCurrent: function () { return myGen === state.generation; },
          shouldStop: function () { return state.stopRequested; },
          onTicket: function () {
            statusLine.textContent = S.modelReady;
            paintCanvas();
            refreshNet();
          },
          onStep: function (step) {
            if (myGen !== state.generation) return;
            /* Paint first (applyState re-renders), then bloom the new
               node, then narrate. */
            paintCanvas();
            bloomForStep(step);
            logStep(narrateStep(step));
            refreshNet();
          },
          onFlag: pauseOnFlag,
          onError: function (err, phase) {
            /* Never render raw engine errors, stacks, or policy
               internals. Plain message for the user, technical detail
               to the console only. */
            console.error("[s1] run failed (" + phase + "):", err);
            logStep(phase === "step" ? S.stepFailed : S.engineFailed, "s1-error");
            statusLine.textContent = phase === "step" ? S.stepFailed : S.engineFailed;
          }
        });
      } catch (e) {
        /* Engine or step failure already surfaced via onError. */
        state.running = false;
        stopBtn.disabled = false;
        setModeLocked(false);
        startOverBtn.focus();
        return;
      }
      state.running = false;
      stopBtn.disabled = false;
      if (!res || res.abandoned) return; /* torn down (Start over) */
      if (res.aborted) {
        var abTexts = Narr.narrate("abort_session",
          { reason: (res.abort && res.abort.reason) || "" }, null, {});
        logStep(lang === "fr" ? abTexts.fr : abTexts.en, "s1-aborted");
        statusLine.textContent = S.stopped;
        paintCanvas();
        setModeLocked(false);
        return;
      }
      openReview();
    }

    function pauseOnFlag() {
      return new Promise(function (resolve) {
        state.flagResolve = function () {
          state.flagResolve = null;
          resolve();
        };
        while (flagBox.firstChild) flagBox.removeChild(flagBox.firstChild);
        flagBox.hidden = false;
        flagBox.appendChild(el("p", "s1-flagmsg", S.flagPaused));
        var btn = el("button", "btn s1-clearflag", S.clearFlag);
        btn.type = "button";
        btn.addEventListener("click", function () {
          H.clearFlagAndContinue();
          flagBox.hidden = true;
          paintCanvas();
          if (state.flagResolve) state.flagResolve();
        });
        flagBox.appendChild(btn);
        btn.focus();
        statusLine.textContent = S.flagPaused;
      });
    }

    /* ---------------- review: an editing workspace ----------------
       The old interrogation rows ("I put X here as Y. Right?") are gone:
       their nested template fill leaked raw {placeholders} (narrate.js).
       Each artifact gets a calm card: a shape icon in the builder's visual
       language, the item name, its type in plain words, and Confirm /
       Rename / Set up / Remove. Type chips (nodes) and category chips
       (flows) sit on the card and change the artifact in place. Cards group
       under headings by kind; every group carries a one-sentence intro.
       After any mutation the whole review list re-renders from a fresh
       deriveChecklist (statuses preserved by ref), so retyped cards move
       groups and renamed nodes propagate to flow labels. */
    var reviewBox = el("div", "s1-review");
    reviewBox.hidden = true;
    var reviewTitle = el("h3", "s1-reviewtitle", S.reviewTitle);
    reviewTitle.tabIndex = -1;
    reviewBox.appendChild(reviewTitle);
    reviewBox.appendChild(el("p", "s1-reviewintro", S.reviewIntro));
    /* Progress toward the results screen: always visible so the reader
       sees that confirming every item is what opens the map-first results. */
    var progressLine = el("p", "s1-reviewprogress", "");
    progressLine.setAttribute("role", "status");
    reviewBox.appendChild(progressLine);
    /* Confirm all: one tap confirms every visible unconfirmed card through
       the same per-card path, so canvas/table/export stay consistent. The
       last confirmRow triggers maybeFinishReview, which opens the results
       screen and moves focus to its heading. */
    var confirmAllBtn = el("button", "btn s1-confirmall", S.confirmAll);
    confirmAllBtn.type = "button";
    confirmAllBtn.addEventListener("click", function () {
      state.checklist
        .filter(function (r) { return r.status !== "confirmed" && r._el && !r._el.hidden; })
        .forEach(function (r) { confirmRow(r, state.checklist.indexOf(r), null); });
    });
    reviewBox.appendChild(confirmAllBtn);
    function updateProgress() {
      var total = state.checklist.length;
      var done = state.checklist.filter(function (r) { return r.status === "confirmed"; }).length;
      progressLine.textContent = total
        ? S.reviewProgress.replace("{done}", String(done)).replace("{total}", String(total))
        : "";
      /* Confirm all only makes sense while something is unconfirmed;
         hidden cards (removed items) never count as pending. */
      var pending = state.checklist.filter(function (r) {
        return r.status !== "confirmed" && r._el && !r._el.hidden;
      }).length;
      confirmAllBtn.hidden = pending === 0;
    }
    var reviewList = el("div", "s1-reviewlist");
    reviewBox.appendChild(reviewList);

    /* Fixed group order; the card text carries a stable groupKey so the
       localized heading never drives the ordering. */
    var GROUP_ORDER = ["collection", "system", "thirdparty", "destruction", "node", "flow", "retention"];

    function cardDataFor(ex, row) {
      if (row.kind === "edge") {
        return {
          aLabel: ex._nodes[row.a] ? ex._nodes[row.a].label : row.a,
          bLabel: ex._nodes[row.b] ? ex._nodes[row.b].label : row.b,
          cat: row.cat
        };
      }
      if (row.kind === "retention") {
        var d = row.detail || {};
        if (d.range === "verify" || d.verify === true) {
          return { label: row.label, verify: true };
        }
        var m = /(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/.exec(d.range || "");
        return m
          ? { label: row.label, min: Number(m[1]), max: Number(m[2]) }
          : { label: row.label };
      }
      return { label: row.label, type: row.detail && row.detail.type };
    }

    var SVGNS = "http://www.w3.org/2000/svg";
    /* Card icons reuse the builder's visual language: circle = collection
       point, rectangle = system, diamond = third party, dashed circle + X =
       secure destruction, arrow glyph = data flow, clock glyph = retention.
       Monochrome ink; nothing red, nothing log-like. */
    function cardIcon(kind, type) {
      var svg = document.createElementNS(SVGNS, "svg");
      svg.setAttribute("viewBox", "0 0 28 28");
      svg.setAttribute("class", "s1-cardicon");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      function shape(tag, attrs) {
        var n = document.createElementNS(SVGNS, tag);
        for (var k in attrs) n.setAttribute(k, attrs[k]);
        svg.appendChild(n);
      }
      var ink = "#0f172a";
      if (kind === "edge") {
        shape("line", { x1: "5", y1: "21", x2: "19", y2: "9", stroke: ink, "stroke-width": "2" });
        shape("polygon", { points: "19,9 12,9 15,15", fill: ink });
      } else if (kind === "retention") {
        shape("circle", { cx: "14", cy: "14", r: "10", fill: "none", stroke: ink, "stroke-width": "2" });
        shape("line", { x1: "14", y1: "14", x2: "14", y2: "8", stroke: ink, "stroke-width": "2" });
        shape("line", { x1: "14", y1: "14", x2: "18", y2: "14", stroke: ink, "stroke-width": "2" });
      } else if (type === "system") {
        shape("rect", { x: "5", y: "8", width: "18", height: "12", rx: "2", fill: "#ffffff", stroke: ink, "stroke-width": "2" });
      } else if (type === "thirdparty") {
        shape("polygon", { points: "14,4 24,14 14,24 4,14", fill: "#ffffff", stroke: ink, "stroke-width": "2" });
      } else if (type === "destruction") {
        shape("circle", { cx: "14", cy: "14", r: "10", fill: "none", stroke: ink, "stroke-width": "2", "stroke-dasharray": "3 2" });
        shape("line", { x1: "9", y1: "9", x2: "19", y2: "19", stroke: ink, "stroke-width": "2" });
        shape("line", { x1: "9", y1: "19", x2: "19", y2: "9", stroke: ink, "stroke-width": "2" });
      } else {
        shape("circle", { cx: "14", cy: "14", r: "10", fill: "#ffffff", stroke: ink, "stroke-width": "2" });
      }
      return svg;
    }

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
      renderReviewCards();
      reviewTitle.focus();
      paintCanvas();
    }

    /* Group titles for the always-rendered addable groups, resolved once
       through the same card-text path as real cards (no duplicated
       strings). */
    function groupTitleFor(key) {
      var probe = key === "flow"
        ? Narr.reviewCardText("edge", { aLabel: "x", bLabel: "y", cat: "contact" }, lang)
        : Narr.reviewCardText("node", { label: "x", type: key }, lang);
      return probe.group;
    }

    function renderReviewCards() {
      var ex = H.controller.executor();
      var buckets = {}, order = [];
      /* The four addable groups always render their header (intro + Add
         button), even when empty, so an Add action is never unreachable
         after removing every card in a group. */
      ["collection", "system", "thirdparty", "flow"].forEach(function (key) {
        buckets[key] = { title: groupTitleFor(key), cards: [] };
        order.push(key);
      });
      state.checklist.forEach(function (row, i) {
        var card = Narr.reviewCardText(row.kind, cardDataFor(ex, row), lang);
        var key = card.groupKey;
        if (!buckets[key]) {
          buckets[key] = { title: card.group, cards: [] };
          order.push(key);
        }
        buckets[key].cards.push({ row: row, i: i, card: card });
      });
      order.sort(function (a, b) { return GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b); });
      order.forEach(function (key) {
        var section = el("section", "s1-cardgroup");
        section.setAttribute("aria-label", buckets[key].title);
        var headRow = el("div", "s1-cardgroup-head");
        headRow.appendChild(el("h4", "s1-cardgroup-title", buckets[key].title));
        var addBtn = addButtonFor(key, section);
        if (addBtn) headRow.appendChild(addBtn);
        section.appendChild(headRow);
        var introKey = "groupIntro" + key.charAt(0).toUpperCase() + key.slice(1);
        if (S[introKey]) section.appendChild(el("p", "s1-cardgroup-intro", S[introKey]));
        buckets[key].cards.forEach(function (c) {
          section.appendChild(renderCard(ex, c.row, c.i, c.card));
        });
        reviewList.appendChild(section);
      });
      updateProgress();
    }

    /* Re-render the whole review list after any mutation (add, remove,
       retype, relabel, set_meta): the checklist is re-derived from the
       executor, per-row statuses are preserved by ref, and the DOM is
       rebuilt. This keeps grouping honest (a retyped card moves groups)
       and propagates renames to flow labels. Returns the rebuilt list. */
    function refreshReviewList() {
      var ex = H.controller.executor();
      var statusByRef = {};
      state.checklist.forEach(function (r) { statusByRef[r.ref] = r.status; });
      state.checklist = Rev.deriveChecklist(ex);
      state.checklist.forEach(function (r) {
        if (statusByRef[r.ref]) r.status = statusByRef[r.ref];
      });
      while (reviewList.firstChild) reviewList.removeChild(reviewList.firstChild);
      renderReviewCards();
    }

    function findCardEl(ref) {
      var row = null;
      state.checklist.forEach(function (r) { if (r.ref === ref) row = r; });
      return row && row._el ? row._el : null;
    }

    /* The live row for a ref: refreshReviewList rebuilds the checklist, so
       handlers that mutate then confirm must re-resolve instead of using
       a detached row object. */
    function findRow(ref) {
      for (var k = 0; k < state.checklist.length; k++) {
        if (state.checklist[k].ref === ref) return state.checklist[k];
      }
      return null;
    }

    /* Add buttons live on the collection/system/thirdparty/flow group
       headers. Add node: allocates the id, paints, and opens the new
       card's Set up editor so the reader names it properly right away. */
    function addButtonFor(key, section) {
      var cfg = {
        collection: { label: S.addCollection, type: "collection", defName: S.newCollectionName },
        system: { label: S.addSystem, type: "system", defName: S.newSystemName },
        thirdparty: { label: S.addThirdparty, type: "thirdparty", defName: S.newThirdpartyName }
      }[key];
      if (cfg) {
        var b = el("button", "btn secondary s1-add", cfg.label);
        b.type = "button";
        b.addEventListener("click", function () { addNode(cfg.type, cfg.defName, b); });
        return b;
      }
      if (key === "flow") {
        var wrap = el("span", "s1-addflowwrap");
        var fb = el("button", "btn secondary s1-add", S.addFlow);
        fb.type = "button";
        var nodeCount = Object.keys(H.controller.executor()._nodes).length;
        if (nodeCount < 2) {
          fb.disabled = true;
          var why = el("span", "s1-addwhy", S.addFlowNeedNodes);
          why.id = "s1-addflow-why";
          fb.setAttribute("aria-describedby", "s1-addflow-why");
          wrap.appendChild(fb);
          wrap.appendChild(why);
        } else {
          fb.addEventListener("click", function () { openAddFlow(section, fb); });
          wrap.appendChild(fb);
        }
        return wrap;
      }
      return null;
    }

    function addNode(type, defName, backTo) {
      var res = H.applyCorrection({ op: "add_node", type: type, label: defName });
      logCorrection("add_node", "node:" + res.after.node_id, null, res.after);
      refreshReviewList();
      paintCanvas();
      bloom(res.after.node_id);
      var msg = Narr.correctionConfirm("add_node", { label: res.after.label }, lang);
      logStep(msg, "s1-corrected");
      /* Open the new card's Set up editor: the reader gives it a real
         name and fills the details immediately. */
      var cardEl = findCardEl("node:" + res.after.node_id);
      var setupBtn = cardEl ? cardEl.querySelector(".s1-setup") : null;
      if (setupBtn) setupBtn.click();
      else if (backTo && typeof backTo.focus === "function") backTo.focus();
      maybeFinishReview();
    }

    function renderCard(ex, row, i, card) {
      var item = el("div", "s1-card");
      item.id = "s1-reviewcard-" + i;
      item.appendChild(cardIcon(row.kind, row.kind === "node" && row.detail ? row.detail.type : null));
      var body = el("div", "s1-cardbody");
      body.appendChild(el("p", "s1-cardname", card.name));
      body.appendChild(el("p", "s1-cardtype", card.typeLine));
      item.appendChild(body);
      var status = el("p", "s1-cardstatus " + row.status, S[row.status] || row.status);
      item.appendChild(status);
      /* Change chips: type chips on every node card (retype), category
         chips on every flow card (reconnect). Nothing the assistant
         decided is locked. */
      if (row.kind === "node") {
        item.appendChild(typeChips(row, ex, item));
      } else if (row.kind === "edge") {
        item.appendChild(catChips(row, ex, item));
      }
      var btnRow = el("div", "s1-cardbtns");
      var confirmBtn = el("button", "btn s1-confirm", S.confirm);
      confirmBtn.type = "button";
      confirmBtn.addEventListener("click", function () { confirmRow(row, i, null); });
      btnRow.appendChild(confirmBtn);
      if (row.kind === "node") {
        var renameBtn = el("button", "btn secondary s1-rename", S.rename);
        renameBtn.type = "button";
        renameBtn.addEventListener("click", function () { openRename(item, row, i, renameBtn); });
        btnRow.appendChild(renameBtn);
        if (["collection", "system", "thirdparty"].indexOf(row.detail.type) !== -1) {
          var setupBtn = el("button", "btn secondary s1-setup", S.setup);
          setupBtn.type = "button";
          setupBtn.addEventListener("click", function () { openSetup(item, row, i, setupBtn); });
          btnRow.appendChild(setupBtn);
        }
      } else if (row.kind === "edge") {
        var flowSetupBtn = el("button", "btn secondary s1-setup", S.setup);
        flowSetupBtn.type = "button";
        flowSetupBtn.addEventListener("click", function () { openSetup(item, row, i, flowSetupBtn); });
        btnRow.appendChild(flowSetupBtn);
      } else if (row.kind === "retention") {
        var verifyBtn = el("button", "btn secondary s1-verify", S.fixVerify);
        verifyBtn.type = "button";
        verifyBtn.addEventListener("click", function () {
          var res = H.applyCorrection({ op: "verify_only", node_id: row.node_id });
          logCorrection("verify_only", row.ref, res.before, res.after);
          refreshReviewList();
          paintCanvas();
          logStep(Narr.correctionConfirm("relabel", { label: row.label }, lang), "s1-corrected");
          /* refreshReviewList rebuilt the cards: confirm the live row, not
             the detached one, so the status updates on the visible card. */
          var live = findRow(row.ref);
          if (live) confirmRow(live, state.checklist.indexOf(live), null);
        });
        btnRow.appendChild(verifyBtn);
      }
      var removeBtn = el("button", "btn secondary s1-remove", S.remove);
      removeBtn.type = "button";
      removeBtn.addEventListener("click", function () { openRemoveConfirm(item, row, i, removeBtn, btnRow); });
      btnRow.appendChild(removeBtn);
      item.appendChild(btnRow);
      /* Confirmed cards keep every action (Confirm / Rename / Set up /
         Remove): the row stays fully operable, only visually quieter, so
         a confirmed item can always be corrected. */
      if (row.status === "confirmed") btnRow.classList.add("s1-confirmed-actions");
      row._el = item;
      row._statusEl = status;
      row._btnRow = btnRow;
      return item;
    }

    /* Type chips for a node card: single-select, aria-pressed on the
       current type; a tap applies the retype op and re-renders. */
    function typeChips(row, ex, item) {
      var wrap = el("div", "s1-typechips");
      wrap.setAttribute("role", "group");
      wrap.setAttribute("aria-label", S.chooseType);
      var typeNames = Narr.PLAIN_TYPE[lang] || Narr.PLAIN_TYPE.en;
      ["collection", "system", "thirdparty", "destruction"].forEach(function (t) {
        var b = el("button", "s1-typechip" + (row.detail.type === t ? " s1-on" : ""), typeNames[t] || t);
        b.type = "button";
        b.setAttribute("aria-pressed", row.detail.type === t ? "true" : "false");
        b.addEventListener("click", function () {
          if (row.detail.type === t) return;
          var res = H.applyCorrection({ op: "retype", node_id: row.node_id, type: t });
          logCorrection("retype", row.ref, res.before, res.after);
          refreshReviewList();
          paintCanvas();
          var msg = Narr.correctionConfirm("retype",
            { label: ex._nodes[row.node_id] ? ex._nodes[row.node_id].label : row.node_id, type: t }, lang);
          logStep(msg, "s1-corrected");
          maybeFinishReview();
        });
        wrap.appendChild(b);
      });
      return wrap;
    }

    /* Category chips for a flow card: single-select via reconnect. */
    function catChips(row, ex, item) {
      var wrap = el("div", "s1-catchips");
      wrap.setAttribute("role", "group");
      wrap.setAttribute("aria-label", S.chooseCategory);
      var catNames = Narr.PLAIN_CAT[lang] || Narr.PLAIN_CAT.en;
      ["contact", "payment", "marketing"].forEach(function (c) {
        var b = el("button", "s1-catchip" + (row.cat === c ? " s1-on" : ""), catNames[c] || c);
        b.type = "button";
        b.setAttribute("aria-pressed", row.cat === c ? "true" : "false");
        b.addEventListener("click", function () {
          if (row.cat === c) return;
          var res = H.applyCorrection({ op: "reconnect", a: row.a, b: row.b, cat: c });
          logCorrection("reconnect", row.ref, res.before, res.after);
          refreshReviewList();
          paintCanvas();
          var msg = Narr.correctionConfirm("reconnect",
            { b_label: ex._nodes[row.b] ? ex._nodes[row.b].label : row.b }, lang);
          logStep(msg, "s1-corrected");
          maybeFinishReview();
        });
        wrap.appendChild(b);
      });
      return wrap;
    }

    /* Rename: the name line swaps for an inline field (prefilled) with
       Save/Cancel. Save applies relabel; Escape cancels. Focus returns to
       the Rename button. */
    function openRename(item, row, i, renameBtn) {
      var nameEl = item.querySelector(".s1-cardname");
      if (!nameEl || item.querySelector(".s1-renamebox")) return;
      var box = el("div", "s1-renamebox");
      box.setAttribute("role", "group");
      box.setAttribute("aria-label", S.rename);
      var inp = document.createElement("input");
      inp.type = "text";
      inp.maxLength = 200;
      inp.value = row.label;
      inp.setAttribute("aria-label", S.newLabel);
      box.appendChild(inp);
      function close(focusBack) {
        box.remove();
        nameEl.hidden = false;
        if (focusBack && typeof renameBtn.focus === "function") renameBtn.focus();
      }
      var save = el("button", "btn secondary s1-renamesave", S.save);
      save.type = "button";
      save.addEventListener("click", function () {
        var v = inp.value.trim();
        if (!v) { inp.focus(); return; }
        var res = H.applyCorrection({ op: "relabel", node_id: row.node_id, label: v });
        logCorrection("relabel", row.ref, res.before, res.after);
        refreshReviewList();
        paintCanvas();
        logStep(Narr.correctionConfirm("relabel", { label: v }, lang), "s1-corrected");
        maybeFinishReview();
        if (typeof renameBtn.focus === "function") renameBtn.focus();
      });
      var cancel = el("button", "btn secondary s1-renamecancel", S.fixCancel);
      cancel.type = "button";
      cancel.addEventListener("click", function () { close(true); });
      box.appendChild(save);
      box.appendChild(cancel);
      box.addEventListener("keydown", function (evt) {
        if (evt.key === "Escape") { evt.preventDefault(); close(true); }
        else if (evt.key === "Enter") { evt.preventDefault(); save.click(); }
      });
      nameEl.hidden = true;
      item.querySelector(".s1-cardbody").appendChild(box);
      inp.focus();
      try { inp.select(); } catch (e) { /* select() is best-effort */ }
    }

    /* Remove: the button row swaps for an inline confirm
       ("Remove this item? Yes, remove / Keep it"). Yes applies the op and
       the card is gone on re-render; Keep restores the row and returns
       focus to Remove. */
    function openRemoveConfirm(item, row, i, removeBtn, btnRow) {
      if (item.querySelector(".s1-removebox")) return;
      btnRow.hidden = true;
      var box = el("div", "s1-removebox");
      box.setAttribute("role", "group");
      box.setAttribute("aria-label", S.remove);
      box.appendChild(el("span", "s1-removeask", S.removeAsk));
      var yes = el("button", "btn secondary s1-removeyes", S.removeYes);
      yes.type = "button";
      var keep = el("button", "btn secondary s1-removekeep", S.removeKeep);
      keep.type = "button";
      yes.addEventListener("click", function () {
        var op = row.kind === "node" ? { op: "remove_node", node_id: row.node_id }
          : row.kind === "edge" ? { op: "remove_edge", a: row.a, b: row.b }
          : { op: "remove_retention", node_id: row.node_id };
        var opName = op.op;
        var res = H.applyCorrection(op);
        logCorrection(opName, row.ref, res.before, res.after);
        refreshReviewList();
        paintCanvas();
        logStep(Narr.correctionConfirm(opName, { label: row.label }, lang), "s1-corrected");
        maybeFinishReview();
      });
      keep.addEventListener("click", function () {
        box.remove();
        btnRow.hidden = false;
        if (typeof removeBtn.focus === "function") removeBtn.focus();
      });
      box.appendChild(yes);
      box.appendChild(keep);
      box.addEventListener("keydown", function (evt) {
        if (evt.key === "Escape") { evt.preventDefault(); keep.click(); }
      });
      btnRow.parentNode.insertBefore(box, btnRow.nextSibling);
      yes.focus();
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
      row._statusEl.className = "s1-cardstatus confirmed";
      row._btnRow.classList.add("s1-confirmed-actions");
      updateProgress();
      maybeFinishReview();
    }

    function logCorrection(op, ref, before, after) {
      var st = H.state();
      state.corrections.push(Rev.correctionLine(st.session_id, st.recipe_id, op, ref, before, after));
    }

    /* The Fix editor lives on the card itself: rename field, retype
       buttons, remove. Native inputs and buttons, so Tab / Space / Enter
       work; Escape cancels. Focus moves into the editor on open and back
       to the card's Fix button on close. */
    /* ---------------- Set up editors ----------------
       Every collection/system/third-party card and every flow card gets a
       "Set up" button opening a detail editor. All fields are optional and
       empty never blocks confirming. Save persists to node.meta / edge.meta
       via the set_meta op (whitelisted string fields); the name field saves
       via relabel; flow from/to/category save via reconnect. Escape
       cancels; focus returns to the Set up button. */
    function fieldLabel(text) { return el("span", "s1-fieldlabel", text); }

    function textField(labelText, value, maxLen) {
      var wrap = el("div", "s1-field");
      var lab = el("label", null, labelText);
      var inp = document.createElement("input");
      inp.type = "text";
      inp.maxLength = maxLen || 500;
      inp.value = value || "";
      lab.appendChild(inp);
      wrap.appendChild(lab);
      return { wrap: wrap, input: inp };
    }

    function chipGroup(labelText, opts, current) {
      var wrap = el("div", "s1-field");
      wrap.appendChild(fieldLabel(labelText));
      var btns = el("div", "s1-chipset");
      btns.setAttribute("role", "group");
      btns.setAttribute("aria-label", labelText);
      var val = current || null;
      opts.forEach(function (o) {
        var b = el("button", "s1-chipopt" + (val === o.v ? " s1-on" : ""), o.label);
        b.type = "button";
        b.setAttribute("aria-pressed", val === o.v ? "true" : "false");
        b.addEventListener("click", function () {
          val = o.v;
          var all = btns.querySelectorAll("button");
          for (var k = 0; k < all.length; k++) {
            var on = all[k] === b;
            all[k].setAttribute("aria-pressed", on ? "true" : "false");
            all[k].className = "s1-chipopt" + (on ? " s1-on" : "");
          }
        });
        btns.appendChild(b);
      });
      wrap.appendChild(btns);
      return { wrap: wrap, get: function () { return val; } };
    }

    function nodeSelect(labelText, currentId) {
      var ex = H.controller.executor();
      var wrap = el("div", "s1-field");
      var lab = el("label", null, labelText);
      var sel = document.createElement("select");
      Object.keys(ex._nodes).sort(function (a, b) {
        return (parseInt(a.slice(1), 10) || 0) - (parseInt(b.slice(1), 10) || 0);
      }).forEach(function (id) {
        var o = document.createElement("option");
        o.value = id;
        o.textContent = (ex._nodes[id] && ex._nodes[id].label) || id;
        if (id === currentId) o.selected = true;
        sel.appendChild(o);
      });
      lab.appendChild(sel);
      wrap.appendChild(lab);
      return { wrap: wrap, select: sel };
    }

    function openSetup(item, row, i, setupBtn) {
      var old = item.querySelector(".s1-setupbox");
      if (old) { old.remove(); if (typeof setupBtn.focus === "function") setupBtn.focus(); return; }
      var ex = H.controller.executor();
      var editor = el("div", "s1-setupbox");
      editor.setAttribute("role", "group");
      editor.setAttribute("aria-label", S.setup);
      var meta = (row.detail && row.detail.meta) || {};
      var fields = [];
      var nameField = null, fromSel = null, toSel = null, catGroup = null;
      var metaCollectors = [];

      function addField(f) { fields.push(f); editor.appendChild(f.wrap); }

      if (row.kind === "node") {
        nameField = textField(S.setupName, row.label, 200);
        addField(nameField);
        var t = row.detail.type;
        if (t === "system") {
          var kg = chipGroup(S.setupSysKind, [
            { v: "internal", label: S.sysKindInternal },
            { v: "cloud", label: S.sysKindCloud },
            { v: "saas", label: S.sysKindSaas }
          ], meta.sys_kind || null);
          addField(kg);
          var holdsF = textField(S.setupHolds, meta.holds, 500); addField(holdsF);
          var regionF = textField(S.setupRegion, meta.region, 120); addField(regionF);
          metaCollectors.push(function (m) {
            if (kg.get()) m.sys_kind = kg.get();
            m.holds = holdsF.input.value.trim();
            m.region = regionF.input.value.trim();
          });
        } else if (t === "collection") {
          var cg = chipGroup(S.setupCollectHow, [
            { v: "online", label: S.methodOnline },
            { v: "phone", label: S.methodPhone },
            { v: "inperson", label: S.methodInPerson },
            { v: "paper", label: S.methodPaper }
          ], meta.collect_how || null);
          addField(cg);
          var notesF = textField(S.setupNotes, meta.notes, 500); addField(notesF);
          metaCollectors.push(function (m) {
            if (cg.get()) m.collect_how = cg.get();
            m.notes = notesF.input.value.trim();
          });
        } else if (t === "thirdparty") {
          var serviceF = textField(S.setupService, meta.service, 500); addField(serviceF);
          var sharedF = textField(S.setupDataShared, meta.data_shared, 500); addField(sharedF);
          metaCollectors.push(function (m) {
            m.service = serviceF.input.value.trim();
            m.data_shared = sharedF.input.value.trim();
          });
        }
      } else if (row.kind === "edge") {
        fromSel = nodeSelect(S.setupFrom, row.a); addField(fromSel);
        toSel = nodeSelect(S.setupTo, row.b); addField(toSel);
        var catNames = Narr.PLAIN_CAT[lang] || Narr.PLAIN_CAT.en;
        catGroup = chipGroup(S.setupCats, ["contact", "payment", "marketing"].map(function (c) {
          return { v: c, label: catNames[c] || c };
        }), row.cat);
        addField(catGroup);
        var whyF = textField(S.setupWhy, meta.why, 500); addField(whyF);
        metaCollectors.push(function (m) { m.why = whyF.input.value.trim(); });
      }

      var errLine = el("p", "s1-fielderr", "");
      errLine.setAttribute("role", "alert");
      errLine.hidden = true;
      editor.appendChild(errLine);

      function close(focusBack) {
        if (closed) return;
        closed = true;
        document.removeEventListener("keydown", onDocKey);
        editor.remove();
        if (focusBack && typeof setupBtn.focus === "function") setupBtn.focus();
      }
      /* Document-level Escape: closing must not depend on which control
         inside the editor holds focus or on bubbling quirks in the host
         page. Removed on every close path (save, cancel, Escape). */
      function onDocKey(evt) {
        if (evt.key === "Escape") { evt.preventDefault(); close(true); }
      }
      var closed = false;
      document.addEventListener("keydown", onDocKey);
      var save = el("button", "btn secondary s1-setupsave", S.save);
      save.type = "button";
      save.addEventListener("click", function () {
        errLine.hidden = true;
        var m = {};
        metaCollectors.forEach(function (fn) { fn(m); });
        if (row.kind === "node") {
          var newName = nameField.input.value.trim();
          if (newName && newName !== row.label) {
            var rres = H.applyCorrection({ op: "relabel", node_id: row.node_id, label: newName });
            logCorrection("relabel", row.ref, rres.before, rres.after);
          }
          var hadMeta = Object.keys(meta).length > 0;
          var hasMeta = hadMeta || Object.keys(m).some(function (k) { return m[k]; });
          if (hasMeta) {
            var mres = H.applyCorrection({ op: "set_meta", node_id: row.node_id, meta: m });
            logCorrection("set_meta", row.ref, mres.before, mres.after);
          }
          logStep(Narr.correctionConfirm("set_meta", {}, lang), "s1-corrected");
        } else if (row.kind === "edge") {
          var a = fromSel.select.value, b = toSel.select.value, c = catGroup.get() || row.cat;
          if (a === b) {
            errLine.textContent = S.addFlowNeedNodes;
            errLine.hidden = false;
            return;
          }
          if (a !== row.a || b !== row.b || c !== row.cat) {
            var cres = H.applyCorrection({ op: "reconnect", a: a, b: b, cat: c });
            logCorrection("reconnect", row.ref, cres.before, cres.after);
          }
          var mres2 = H.applyCorrection({ op: "set_meta", a: a, b: b, meta: m });
          logCorrection("set_meta", row.ref, mres2.before, mres2.after);
          logStep(Narr.correctionConfirm("set_meta", {}, lang), "s1-corrected");
        }
        refreshReviewList();
        paintCanvas();
        maybeFinishReview();
        close(true);
      });
      var cancel = el("button", "btn secondary s1-setupcancel", S.fixCancel);
      cancel.type = "button";
      cancel.addEventListener("click", function () { close(true); });
      var btnRow = el("div", "s1-setupbtns");
      btnRow.appendChild(save);
      btnRow.appendChild(cancel);
      editor.appendChild(btnRow);
      item.appendChild(editor);
      var first = editor.querySelector("input, select, button");
      if (first) first.focus();
    }

    /* Add data flow: an inline form in the flow group (from/to selects,
       category chips, why). The header button stays disabled with a plain
       reason while fewer than two nodes exist. */
    function openAddFlow(section, backTo) {
      if (section.querySelector(".s1-addflowbox")) return;
      var ex = H.controller.executor();
      var form = el("div", "s1-addflowbox");
      form.setAttribute("role", "group");
      form.setAttribute("aria-label", S.addFlow);
      var fromSel = nodeSelect(S.setupFrom, null);
      var toSel = nodeSelect(S.setupTo, null);
      form.appendChild(fromSel.wrap);
      form.appendChild(toSel.wrap);
      var catNames = Narr.PLAIN_CAT[lang] || Narr.PLAIN_CAT.en;
      var catGroup = chipGroup(S.setupCats, ["contact", "payment", "marketing"].map(function (c) {
        return { v: c, label: catNames[c] || c };
      }), "contact");
      form.appendChild(catGroup.wrap);
      var whyF = textField(S.setupWhy, "", 500);
      form.appendChild(whyF.wrap);
      var errLine = el("p", "s1-fielderr", "");
      errLine.setAttribute("role", "alert");
      errLine.hidden = true;
      form.appendChild(errLine);
      function close(focusBack) {
        form.remove();
        if (focusBack && backTo && typeof backTo.focus === "function") backTo.focus();
      }
      var add = el("button", "btn secondary s1-addflowsave", S.addFlow);
      add.type = "button";
      add.addEventListener("click", function () {
        var a = fromSel.select.value, b = toSel.select.value, c = catGroup.get() || "contact";
        errLine.hidden = true;
        if (!a || !b || a === b) {
          errLine.textContent = S.addFlowNeedNodes;
          errLine.hidden = false;
          return;
        }
        var dup = ex._edges.some(function (e) {
          return (e.a === a && e.b === b) || (e.a === b && e.b === a);
        });
        if (dup) {
          errLine.textContent = S.addFlowNeedNodes;
          errLine.hidden = false;
          return;
        }
        var res = H.applyCorrection({ op: "add_edge", a: a, b: b, cat: c });
        var why = whyF.input.value.trim();
        if (why) {
          var mres = H.applyCorrection({ op: "set_meta", a: a, b: b, meta: { why: why } });
          logCorrection("set_meta", "edge:" + a + "->" + b, mres.before, mres.after);
        }
        logCorrection("add_edge", "edge:" + a + "->" + b, null, res.after);
        refreshReviewList();
        paintCanvas();
        var msg = Narr.correctionConfirm("add_edge", {
          a_label: ex._nodes[a] ? ex._nodes[a].label : a,
          b_label: ex._nodes[b] ? ex._nodes[b].label : b
        }, lang);
        logStep(msg, "s1-corrected");
        close(true);
        maybeFinishReview();
      });
      var cancel = el("button", "btn secondary s1-addflowcancel", S.fixCancel);
      cancel.type = "button";
      cancel.addEventListener("click", function () { close(true); });
      var btnRow = el("div", "s1-setupbtns");
      btnRow.appendChild(add);
      btnRow.appendChild(cancel);
      form.appendChild(btnRow);
      form.addEventListener("keydown", function (evt) {
        if (evt.key === "Escape") { evt.preventDefault(); close(true); }
      });
      var firstCard = section.querySelector(".s1-card");
      section.insertBefore(form, firstCard);
      var first = form.querySelector("select, button");
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

    /* ---------------- done: map-first results ----------------
       The results screen leads with the populated MAP (the same shapes,
       styles, and node layout as the builder canvas), a Map/Table toggle,
       then export. Excel is an export option, never the destination. The
       DRAFT banner + cover sheet + review checklist behavior lives in the
       exporter; the corrections download and the wipe button stay. */
    var doneBox = el("div", "s1-done");
    doneBox.hidden = true;
    var doneTitle = el("h3", "s1-donetitle", S.resultsTitle);
    doneTitle.tabIndex = -1;
    doneBox.appendChild(doneTitle);
    doneBox.appendChild(el("p", "s1-donelede", S.resultsLede));

    /* Map/Table toggle: native radio group, keyboard-operable. */
    var viewToggle = el("fieldset", "s1-viewtoggle");
    viewToggle.appendChild(el("legend", "s1-viewlabel", S.viewLabel));
    var viewName = (opts.rootId || "s1-assistant") + "-view";
    var viewRadios = [];
    [["map", S.viewMap], ["table", S.viewTable]].forEach(function (v, i) {
      var label = el("label", "s1-viewopt");
      var radio = document.createElement("input");
      radio.type = "radio";
      radio.name = viewName;
      radio.value = v[0];
      radio.checked = i === 0;
      label.appendChild(radio);
      label.appendChild(el("span", null, v[1]));
      radio.addEventListener("change", function () { setResultsView(v[0]); });
      viewToggle.appendChild(label);
      viewRadios.push(radio);
    });
    doneBox.appendChild(viewToggle);

    var mapWrap = el("div", "s1-mapwrap");
    var tableWrap = el("div", "s1-tablewrap");
    tableWrap.hidden = true;
    doneBox.appendChild(mapWrap);
    doneBox.appendChild(tableWrap);

    function setResultsView(v) {
      mapWrap.hidden = v !== "map";
      tableWrap.hidden = v !== "table";
      viewRadios.forEach(function (r) { r.checked = (r.value === v); });
    }

    var RNS = "http://www.w3.org/2000/svg";
    /* Results map: the same geometry as the builder canvas (builder.js
       shapeFor), same 640x420 viewBox, same node layout from the executor
       state. Page-level .edge / .node-label styles apply automatically
       since the class names match. */
    function renderResultMap(st) {
      while (mapWrap.firstChild) mapWrap.removeChild(mapWrap.firstChild);
      var svg = document.createElementNS(RNS, "svg");
      svg.setAttribute("viewBox", "0 0 640 420");
      svg.setAttribute("class", "s1-resultmap");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", S.resultsMapLabel);
      function mk(tag, attrs) {
        var n = document.createElementNS(RNS, tag);
        for (var k in attrs) n.setAttribute(k, attrs[k]);
        return n;
      }
      (st.edges || []).forEach(function (e) {
        var A = st.nodes[e.a], B = st.nodes[e.b];
        if (!A || !B) return;
        var dx = B.x - A.x, dy = B.y - A.y;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        svg.appendChild(mk("path", {
          "class": "edge " + e.cat,
          d: "M" + (A.x + dx / len * 28) + "," + (A.y + dy / len * 28) +
             " L" + (B.x - dx / len * 32) + "," + (B.y - dy / len * 32)
        }));
      });
      Object.keys(st.nodes || {}).forEach(function (id) {
        var def = st.nodes[id];
        var g = mk("g", { "class": "node", transform: "translate(" + def.x + "," + def.y + ")" });
        var s;
        if (def.type === "collection") {
          s = mk("circle", { "class": "shape", r: "24", fill: "#ffffff", stroke: "#0f172a", "stroke-width": "2" });
        } else if (def.type === "system") {
          s = mk("rect", { "class": "shape", x: "-52", y: "-24", width: "104", height: "48", rx: "8", fill: "#ffffff", stroke: "#0f172a", "stroke-width": "2" });
        } else if (def.type === "thirdparty") {
          s = mk("polygon", { "class": "shape", points: "0,-27 31,0 0,27 -31,0", fill: "#ffffff", stroke: "#0f172a", "stroke-width": "2" });
        } else {
          s = mk("g", { "class": "shape" });
          s.appendChild(mk("circle", { r: "24", fill: "none", stroke: "#b3401f", "stroke-width": "2", "stroke-dasharray": "5 4" }));
          s.appendChild(mk("line", { x1: "-13", y1: "-13", x2: "13", y2: "13", stroke: "#b3401f", "stroke-width": "3" }));
          s.appendChild(mk("line", { x1: "-13", y1: "13", x2: "13", y2: "-13", stroke: "#b3401f", "stroke-width": "3" }));
        }
        g.appendChild(s);
        var t = mk("text", { "class": "node-label", y: "40", "text-anchor": "middle" });
        t.textContent = def.label;
        g.appendChild(t);
        var title = mk("title", {});
        title.textContent = def.label;
        g.appendChild(title);
        svg.appendChild(g);
      });
      mapWrap.appendChild(svg);
    }

    function renderResultTables(st) {
      while (tableWrap.firstChild) tableWrap.removeChild(tableWrap.firstChild);
      var typeNames = Narr.PLAIN_TYPE[lang] || Narr.PLAIN_TYPE.en;
      var catNames = Narr.PLAIN_CAT[lang] || Narr.PLAIN_CAT.en;
      function table(caption, headers, rows) {
        var wrap = el("div", "s1-resulttable");
        wrap.appendChild(el("h4", "s1-resulttable-title", caption));
        var tb = document.createElement("table");
        var head = document.createElement("tr");
        headers.forEach(function (h) {
          var th = document.createElement("th");
          th.textContent = h;
          head.appendChild(th);
        });
        tb.appendChild(head);
        rows.forEach(function (r) {
          var tr = document.createElement("tr");
          r.forEach(function (c) {
            var td = document.createElement("td");
            td.textContent = c;
            tr.appendChild(td);
          });
          tb.appendChild(tr);
        });
        wrap.appendChild(tb);
        return wrap;
      }
      var nodeIds = Object.keys(st.nodes || {});
      var nodeRows = nodeIds.map(function (id) {
        var n = st.nodes[id];
        return [n.label, typeNames[n.type] || n.type, Exp.metaText(n.meta || {}, lang)];
      });
      var edgeRows = (st.edges || []).map(function (e) {
        var A = st.nodes[e.a], B = st.nodes[e.b];
        return [(A && A.label) || e.a, (B && B.label) || e.b, catNames[e.cat] || e.cat,
          Exp.metaText(e.meta || {}, lang)];
      });
      tableWrap.appendChild(table(S.tableNodes + " (" + nodeRows.length + ")",
        [S.thName, S.thType, S.thDetails], nodeRows));
      tableWrap.appendChild(table(S.tableConns + " (" + edgeRows.length + ")",
        [S.thFrom, S.thTo, S.thCategory, S.thDetails], edgeRows));
    }

    var dlRow = el("div", "s1-dlrow");
    var dlBtn = el("button", "btn s1-download", S.downloadExcel);
    dlBtn.type = "button";
    dlBtn.addEventListener("click", downloadExcel);
    var viewMapBtn = el("button", "btn secondary s1-viewmap", S.viewOnMap);
    viewMapBtn.type = "button";
    viewMapBtn.addEventListener("click", function () {
      /* The builder canvas holds the same draft map (painted live during
         the run via DMImport); scroll the reader to it. */
      var sec = document.getElementById("builder-section");
      if (sec && typeof sec.scrollIntoView === "function") {
        try { sec.scrollIntoView({ block: "start", behavior: "smooth" }); }
        catch (e) { sec.scrollIntoView(); }
      }
    });
    var corrBtn = el("button", "btn secondary s1-corr", S.downloadCorrections);
    corrBtn.type = "button";
    corrBtn.addEventListener("click", downloadCorrections);
    var wipeBtn = el("button", "btn secondary s1-wipe", S.wipe);
    wipeBtn.type = "button";
    wipeBtn.addEventListener("click", wipe);
    dlRow.appendChild(dlBtn);
    dlRow.appendChild(viewMapBtn);
    dlRow.appendChild(corrBtn);
    dlRow.appendChild(wipeBtn);
    doneBox.appendChild(dlRow);

    function openDone() {
      var st = H.state();
      renderResultMap(st);
      renderResultTables(st);
      setResultsView("map");
      reviewBox.hidden = true;
      doneBox.hidden = false;
      doneTitle.focus();
    }

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

    /* Tear the run down and restore the intake form to its initial state:
       chips unselected, step log and review cleared, flag box hidden, run /
       review / done panels hidden, intake shown, focus back on the entry
       title. Bumps the run generation so a stale run loop exits quietly
       (no console errors) instead of writing into the cleared panels.
       Shared by the Steps-panel "Start over" button (both flows reach this
       panel) and the "Wipe everything" button.
       2026-10-05 (wipe hardening): every stage is guarded so a failure in
       one (e.g. the chat reset touching live chat DOM) can never strand
       the teardown: the executor reset, panel restore, and canvas clear
       always run. */
    function teardownToIntake() {
      state.generation++;
      if (state.flagResolve) {
        try { state.flagResolve(); } catch (e) { /* ignore */ }
      }
      try { H.reset(); } catch (e) { console.error("[s1] wipe: executor reset failed:", e); }
      state.chips = { size: null, sector: null, region: null, types: null };
      state.template = null;
      state.checklist = [];
      state.confirmations = [];
      state.corrections = [];
      state.reviewed = false;
      state.running = false;
      state.stopRequested = false;
      try {
        stopBtn.disabled = false;
        Object.keys(chipInputs).forEach(function (cid) {
          var radios = chipInputs[cid].querySelectorAll("input");
          for (var i = 0; i < radios.length; i++) radios[i].checked = false;
        });
        while (templateBox.firstChild) templateBox.removeChild(templateBox.firstChild);
        while (stepLog.firstChild) stepLog.removeChild(stepLog.firstChild);
        while (reviewList.firstChild) reviewList.removeChild(reviewList.firstChild);
        flagBox.hidden = true;
        statusLine.textContent = "";
        runBox.hidden = true;
        reviewBox.hidden = true;
        doneBox.hidden = true;
        modeWrap.hidden = false;
        setModeLocked(false);
        modeNote.textContent = "";
      } catch (e) { console.error("[s1] wipe: panel restore failed:", e); }
      /* The guided pane may hold a stale handoff; restart its conversation
         so a return to that mode starts clean. Guarded: a chat failure
         must not strand the wipe. */
      if (chatApi) {
        try {
          chatApi.show();
          chatApi.reset();
        } catch (e) { console.error("[s1] wipe: chat reset failed:", e); }
      }
      /* Canvas clear runs unconditionally (executor state is already
         gone, including node/edge meta): the builder canvas must end up
         empty even if an earlier stage threw. */
      try {
        if (root.DMImport && typeof root.DMImport.applyState === "function") {
          root.DMImport.applyState({ nodes: {}, edges: [] });
        }
      } catch (e) { console.error("[s1] wipe: canvas clear failed:", e); }
    }

    /* Recovery path for a failed or abandoned run: no confirmation, so one
       tap returns to a clean intake. Also resets the trust counter to 0. */
    function startOver() {
      teardownToIntake();
      try {
        if (root.__s1net && typeof root.__s1net.reset === "function") root.__s1net.reset();
      } catch (e) { /* counter reset is best-effort */ }
      refreshNet();
      panelTitle.focus();
    }

    /* One-click wipe, confirmed inline. Native window.confirm is not used:
       automation (and the managed browser QA) auto-dismisses native
       dialogs, which silently aborted the wipe and left every node, card,
       and meta field in place. The inline confirm works the same for a
       human and for automation. */
    function wipe() {
      if (dlRow.parentNode.querySelector(".s1-wipebox")) return;
      dlRow.hidden = true;
      var box = el("div", "s1-wipebox");
      box.setAttribute("role", "group");
      box.setAttribute("aria-label", S.wipe);
      box.appendChild(el("span", "s1-wipeask", S.wipeAsk));
      var yes = el("button", "btn secondary s1-wipeyes", S.wipeYes);
      yes.type = "button";
      var keep = el("button", "btn secondary s1-wipekeep", S.wipeKeep);
      keep.type = "button";
      function closeBox(restoreFocus) {
        box.remove();
        dlRow.hidden = false;
        if (restoreFocus && typeof wipeBtn.focus === "function") wipeBtn.focus();
      }
      yes.addEventListener("click", function () {
        closeBox(false);
        teardownToIntake();
        statusLine.textContent = S.wipeDone;
        panelTitle.focus();
        try { refreshNet(); } catch (e) { /* counter reset is best-effort */ }
      });
      keep.addEventListener("click", function () { closeBox(true); });
      box.appendChild(yes);
      box.appendChild(keep);
      box.addEventListener("keydown", function (evt) {
        if (evt.key === "Escape") { evt.preventDefault(); closeBox(true); }
      });
      dlRow.parentNode.insertBefore(box, dlRow.nextSibling);
      yes.focus();
    }

    /* The conversational panel authors the recipe and narrates the run;
       when the run completes it hands the live session to this panel's
       review/export/wipe UI. Hiding the whole mode chrome keeps one
       panel, one flow: the review is the same screen either mode lands on. */
    function enterReview() {
      if (state.running) return false;
      if (!H.controller.executor()) return false;
      modeWrap.hidden = true;
      runBox.hidden = true;
      doneBox.hidden = true;
      openReview();
      return true;
    }

    host.appendChild(trustBar);
    host.appendChild(modeWrap);
    host.appendChild(runBox);
    host.appendChild(reviewBox);
    host.appendChild(doneBox);

    /* Guided-chat mode: the chatbot module mounts embedded into the chat
       slot. Its standalone chrome is skipped (embed:true); the panel owns
       the title, lede, and trust line. The run handoff still lands in this
       panel's review/export/wipe UI via enterReview. When the chatbot
       script is absent, the guided option is hidden and the quick mode
       stands alone. */
    var handle = {
      state: state,
      startRun: startRun,
      wipe: wipe,
      refreshNet: refreshNet,
      enterReview: enterReview,
      refreshReviewList: refreshReviewList,
      setModeLocked: setModeLocked
    };
    if (root.S1Chatbot && typeof root.S1Chatbot.init === "function") {
      chatApi = root.S1Chatbot.init({ rootId: chatSlot.id, lang: lang, embed: true, uiHandle: handle });
    } else {
      modeLabels[1].hidden = true;
    }

    /* The step-5 builder's "Wipe canvas" button calls this after clearing
       its own nodes: the whole assistant session (review cards, executor
       state including meta, panels) dies with the canvas, so a later
       review action cannot repaint the cleared map from stale state. */
    root.__s1ExternalWipe = function () {
      teardownToIntake();
      try { refreshNet(); } catch (e) { /* counter reset is best-effort */ }
    };

    return handle;
  }

  return { init: init };
});
