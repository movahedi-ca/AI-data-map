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

    /* ---------------- review: grouped cards ----------------
       The old interrogation rows ("I put X here as Y. Right?") are gone:
       their nested template fill leaked raw {placeholders} (narrate.js).
       Each artifact now gets a calm card: a shape icon in the builder's
       visual language, the item name, its type in plain words, and
       Confirm / Fix. Cards group under headings by kind. Fix opens a real
       inline editor on the card. */
    var reviewBox = el("div", "s1-review");
    reviewBox.hidden = true;
    var reviewTitle = el("h3", "s1-reviewtitle", S.reviewTitle);
    reviewTitle.tabIndex = -1;
    reviewBox.appendChild(reviewTitle);
    reviewBox.appendChild(el("p", "s1-reviewlede", S.reviewLede));
    reviewBox.appendChild(el("p", "s1-reviewexplain", S.reviewExplain));
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

    function renderReviewCards() {
      var ex = H.controller.executor();
      var buckets = {}, order = [];
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
        section.appendChild(el("h4", "s1-cardgroup-title", buckets[key].title));
        buckets[key].cards.forEach(function (c) {
          section.appendChild(renderCard(ex, c.row, c.i, c.card));
        });
        reviewList.appendChild(section);
      });
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
      var btnRow = el("div", "s1-cardbtns");
      var confirmBtn = el("button", "btn s1-confirm", S.confirm);
      confirmBtn.type = "button";
      var fixBtn = el("button", "btn secondary s1-fix", S.fix);
      fixBtn.type = "button";
      confirmBtn.addEventListener("click", function () { confirmRow(row, i, null); });
      fixBtn.addEventListener("click", function () { openCardEditor(item, row, i, fixBtn); });
      btnRow.appendChild(confirmBtn);
      btnRow.appendChild(fixBtn);
      item.appendChild(btnRow);
      row._el = item;
      row._statusEl = status;
      row._btnRow = btnRow;
      row._fixBtn = fixBtn;
      return item;
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
      row._btnRow.hidden = true;
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
    function openCardEditor(item, row, i, fixBtn) {
      var ex = H.controller.executor();
      var old = item.querySelector(".s1-cardeditor");
      if (old) { closeEditor(old, fixBtn); return; }
      var editor = el("div", "s1-cardeditor");
      editor.setAttribute("role", "group");
      editor.setAttribute("aria-label", S.fix);
      function closeEditor(ed, backTo) {
        ed.remove();
        if (backTo && typeof backTo.focus === "function") backTo.focus();
      }
      function addBtn(text, fn) {
        var b = el("button", "btn secondary s1-fixopt", text);
        b.type = "button";
        b.addEventListener("click", fn);
        editor.appendChild(b);
        return b;
      }
      function doneFix(opName, op, confirmKind, ctx) {
        var res = H.applyCorrection(op);
        logCorrection(opName, row.ref, res.before, res.after);
        refreshCard(row, ex, item);
        paintCanvas();
        var msg = Narr.correctionConfirm(confirmKind, ctx || {}, lang);
        logStep(msg, "s1-corrected");
        closeEditor(editor, fixBtn);
        confirmRow(row, i, null);
      }
      /* After a correction mutates the executor, re-derive the affected
         checklist row so the card and the exported Review sheet describe
         the corrected state, not the pre-fix state. Rows for removed
         artifacts keep a marker so the sheet stays honest instead of
         stale. */
      function refreshCard(row, ex, item) {
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
        if (item && !row.removed) {
          var c = Narr.reviewCardText(row.kind, cardDataFor(ex, row), lang);
          var nameEl = item.querySelector(".s1-cardname");
          var typeEl = item.querySelector(".s1-cardtype");
          if (nameEl) nameEl.textContent = c.name;
          if (typeEl) typeEl.textContent = c.typeLine;
          var iconEl = item.querySelector(".s1-cardicon");
          if (iconEl && typeof iconEl.replaceWith === "function") {
            iconEl.replaceWith(cardIcon(row.kind, row.kind === "node" && row.detail ? row.detail.type : null));
          }
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
        editor.appendChild(lab);
        addBtn(S.fixRelabel, function () {
          var v = inp.value.trim();
          if (!v) { inp.focus(); return; }
          doneFix("relabel", { op: "relabel", node_id: row.node_id, label: v }, "relabel", { label: v });
        });
        var typeNames = Narr.PLAIN_TYPE[lang] || Narr.PLAIN_TYPE.en;
        ["collection", "system", "thirdparty", "destruction"].forEach(function (t) {
          addBtn(typeNames[t] || t, function () {
            doneFix("retype", { op: "retype", node_id: row.node_id, type: t }, "retype",
              { label: ex._nodes[row.node_id] ? ex._nodes[row.node_id].label : row.node_id, type: t });
          });
        });
        addBtn(S.fixRemove, function () {
          doneFix("remove_node", { op: "remove_node", node_id: row.node_id }, "relabel", { label: row.label });
          row._el.hidden = true;
        });
      } else if (row.kind === "edge") {
        var catNames = Narr.PLAIN_CAT[lang] || Narr.PLAIN_CAT.en;
        ["contact", "payment", "marketing"].forEach(function (c) {
          addBtn(catNames[c] || c, function () {
            doneFix("reconnect", { op: "reconnect", a: row.a, b: row.b, cat: c }, "reconnect",
              { b_label: ex._nodes[row.b] ? ex._nodes[row.b].label : row.b });
          });
        });
        addBtn(S.fixRemove, function () {
          var res = H.applyCorrection({ op: "remove_edge", a: row.a, b: row.b });
          logCorrection("remove_edge", row.ref, res.before, res.after);
          refreshCard(row, ex, item);
          paintCanvas();
          closeEditor(editor, fixBtn);
          row._el.hidden = true;
          maybeFinishReview();
        });
      } else if (row.kind === "retention") {
        addBtn(S.fixVerify, function () {
          var res = H.applyCorrection({ op: "verify_only", node_id: row.node_id });
          logCorrection("verify_only", row.ref, res.before, res.after);
          refreshCard(row, ex, item);
          paintCanvas();
          closeEditor(editor, fixBtn);
          confirmRow(row, i, null);
        });
      }
      var cancel = el("button", "btn secondary s1-fixcancel", S.fixCancel);
      cancel.type = "button";
      cancel.addEventListener("click", function () { closeEditor(editor, fixBtn); });
      editor.appendChild(cancel);
      editor.addEventListener("keydown", function (evt) {
        if (evt.key === "Escape") {
          evt.preventDefault();
          closeEditor(editor, fixBtn);
        }
      });
      item.appendChild(editor);
      var first = editor.querySelector("input, button");
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
        return [n.label, typeNames[n.type] || n.type];
      });
      var edgeRows = (st.edges || []).map(function (e) {
        var A = st.nodes[e.a], B = st.nodes[e.b];
        return [(A && A.label) || e.a, (B && B.label) || e.b, catNames[e.cat] || e.cat];
      });
      tableWrap.appendChild(table(S.tableNodes + " (" + nodeRows.length + ")", [S.thName, S.thType], nodeRows));
      tableWrap.appendChild(table(S.tableConns + " (" + edgeRows.length + ")", [S.thFrom, S.thTo, S.thCategory], edgeRows));
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
       panel) and the "Wipe everything" button. */
    function teardownToIntake() {
      state.generation++;
      if (state.flagResolve) {
        try { state.flagResolve(); } catch (e) { /* ignore */ }
      }
      H.reset();
      state.chips = { size: null, sector: null, region: null, types: null };
      state.template = null;
      state.checklist = [];
      state.confirmations = [];
      state.corrections = [];
      state.reviewed = false;
      state.running = false;
      state.stopRequested = false;
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
      /* The guided pane may hold a stale handoff; restart its conversation
         so a return to that mode starts clean. */
      if (chatApi) {
        chatApi.show();
        chatApi.reset();
      }
      try {
        if (root.DMImport && typeof root.DMImport.applyState === "function") {
          root.DMImport.applyState({ nodes: {}, edges: [] });
        }
      } catch (e) { /* ignore */ }
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

    function wipe() {
      if (!window.confirm(S.wipeConfirm)) return;
      teardownToIntake();
      statusLine.textContent = S.wipeDone;
      panelTitle.focus();
      refreshNet();
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
      setModeLocked: setModeLocked
    };
    if (root.S1Chatbot && typeof root.S1Chatbot.init === "function") {
      chatApi = root.S1Chatbot.init({ rootId: chatSlot.id, lang: lang, embed: true, uiHandle: handle });
    } else {
      modeLabels[1].hidden = true;
    }

    return handle;
  }

  return { init: init };
});
