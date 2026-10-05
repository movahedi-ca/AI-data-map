/**
 * chatbot.js - deterministic conversational intake for the System-1 executor.
 *
 * A chat-style panel: greets, asks the 4 chip questions in order (tappable
 * chips, zero typing, keyboard-operable), calls S1Templates.selectTemplate
 * on the chip vector, shows the matched template, calls
 * __s1executor.start(recipe) and shows the session ticket, then narrates the
 * model-driven run into the chat with the Phase 6 narration templates, and
 * finally hands off to the existing review/export/wipe UI (S1UI).
 *
 * A pasted recipe JSON is the alternate path: it is validated structurally
 * (deterministic, zero tokens) and rejected with a plain-language message
 * naming the problem. The chatbot never executes; it authors recipes and
 * narrates. The executor does the running.
 *
 * Embed mode (opts.embed): the chatbot mounts inside the single S1UI panel
 * (one assistant, one panel). The standalone trust line, title, and lede
 * are skipped because the panel already renders one of each; the run
 * handoff still lands in the panel's review/export/wipe UI. Engine
 * failures surface as plain human messages; raw detail goes to the
 * console only, the same treatment the executor's error boundary gives.
 *
 * Depends on (load order): narrate.js, templates.js, i18n.js, executor.js,
 * and ui.js for the handoff (S1UI handle passed to init).
 * UMD: runs in browsers and Node (pure validator is DOM-free). No network,
 * no storage, no em dashes.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module !== null && typeof module.exports === "object") {
    module.exports = api;
  } else {
    root.S1Chatbot = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* Resolve sibling modules lazily so Node tests can inject them via
     globalThis before requiring this file. */
  function RT() {
    if (typeof self !== "undefined") return self;
    if (typeof window !== "undefined") return window;
    return Function("return this")();
  }

  function deps() {
    var r = RT();
    return {
      Tmpl: r.S1Templates,
      Narr: r.S1Narrate,
      I18n: r.S1I18n,
      Exec: r.S1Executor
    };
  }

  var CHIP_ORDER = ["size", "sector", "region", "types"];
  var PACE_MS = 450;

  /* ---------------- recipe validation (pure, DOM-free) ---------------- */

  var RECIPE_ID_RE = /^[A-Za-z0-9_-]+$/;
  var SCHEMA_RE = /^1\.0\.[0-9]+$/;
  var AUTHORING_INTENTS = {
    add_node: 1, add_collection_point: 1, connect: 1, set_field: 1,
    set_retention: 1, run_check: 1, export: 1, confirm_node: 1, flag_for_review: 1
  };
  var RECOVERY_INTENTS = { undo_last: 1, skip_recipe_item: 1, abort_session: 1 };
  var REQUIRED_PARAMS = {
    add_node: ["node_id", "type", "x", "y", "label"],
    add_collection_point: ["node_id", "x", "y", "label"],
    connect: ["a", "b", "cat"],
    set_field: ["node_id", "field", "value"],
    set_retention: ["node_id", "record_type"],
    run_check: ["checks"],
    export: ["format"],
    confirm_node: ["node_id"],
    flag_for_review: ["reason"]
  };

  function fill(template, vars) {
    return String(template).replace(/\{([a-zA-Z_]+)\}/g, function (m, k) {
      return vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m;
    });
  }

  /**
   * Deterministic structural check of a pasted recipe JSON.
   * Returns {ok: true, recipe} or {ok: false, message} with a
   * plain-language message naming the problem (localized).
   */
  function validateRecipeText(text, lang) {
    var I18n = deps().I18n;
    var S = I18n.strings(lang === "fr" ? "fr" : "en");
    var recipe;
    try {
      recipe = JSON.parse(text);
    } catch (e) {
      return { ok: false, message: S.chatErrNotJson };
    }
    if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
      return { ok: false, message: S.chatErrNotObject };
    }
    if (typeof recipe.recipe_id !== "string" || !RECIPE_ID_RE.test(recipe.recipe_id)) {
      return { ok: false, message: S.chatErrBadRecipeId };
    }
    if (typeof recipe.schema_version !== "string" || !SCHEMA_RE.test(recipe.schema_version)) {
      return { ok: false, message: fill(S.chatErrBadSchema, { got: String(recipe.schema_version) }) };
    }
    if (!Array.isArray(recipe.items) || recipe.items.length === 0) {
      return { ok: false, message: S.chatErrNoItems };
    }
    for (var i = 0; i < recipe.items.length; i++) {
      var it = recipe.items[i];
      if (!it || typeof it !== "object" || Array.isArray(it)) {
        return { ok: false, message: fill(S.chatErrItemNotObject, { index: i }) };
      }
      var intent = it.intent;
      if (typeof intent !== "string" || !AUTHORING_INTENTS[intent]) {
        if (RECOVERY_INTENTS[intent]) {
          return { ok: false, message: fill(S.chatErrRecoveryIntent, { index: i, intent: intent }) };
        }
        return { ok: false, message: fill(S.chatErrUnknownIntent, { index: i, intent: String(intent) }) };
      }
      if (!it.params || typeof it.params !== "object" || Array.isArray(it.params)) {
        return { ok: false, message: fill(S.chatErrParamsNotObject, { index: i }) };
      }
      var req = REQUIRED_PARAMS[intent];
      for (var r = 0; r < req.length; r++) {
        if (it.params[req[r]] === undefined) {
          return { ok: false, message: fill(S.chatErrMissingParam, { index: i, intent: intent, param: req[r] }) };
        }
      }
      if (intent === "run_check" && !Array.isArray(it.params.checks)) {
        return { ok: false, message: fill(S.chatErrMissingParam, { index: i, intent: intent, param: "checks (array)" }) };
      }
      if (intent === "set_retention") {
        var p = it.params;
        var hasRange = p.range_min_years !== undefined && p.range_max_years !== undefined && p.statute !== undefined;
        if (!hasRange && p.verify_only !== true) {
          return { ok: false, message: fill(S.chatErrRetentionRange, { index: i }) };
        }
      }
    }
    return { ok: true, recipe: recipe };
  }

  /* ---------------- DOM helpers ---------------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== null && text !== undefined) n.textContent = text;
    return n;
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /* ---------------- the chat UI ---------------- */

  function init(opts) {
    opts = opts || {};
    var d = deps();
    var Tmpl = d.Tmpl, Narr = d.Narr, I18n = d.I18n, Exec = d.Exec;
    if (!Tmpl || !Narr || !I18n || !Exec) {
      throw new Error("chatbot.js requires templates.js, narrate.js, i18n.js, and executor.js to load first.");
    }
    var lang = opts.lang === "fr" ? "fr" : "en";
    var S = I18n.strings(lang);
    var H = Exec.hooks;
    var uiHandle = opts.uiHandle || null;
    /* embed:true mounts the conversation inside the single S1UI panel: the
       standalone trust line, title, and lede are skipped because the panel
       already renders one of each. */
    var embed = !!opts.embed;

    var host = document.getElementById(opts.rootId || "s1-chatbot");
    if (!host) return null;

    var state = {
      stage: "greet",
      /* qIndex tracks which question the conversation is actually on
         (index into CHIP_ORDER). The paste-view Back handler uses it to
         restore the right question's chips instead of hardcoded Q1. */
      qIndex: 0,
      chips: { size: null, sector: null, region: null, types: null },
      recipe: null,
      running: false,
      stopRequested: false,
      netTimer: null
    };

    var chat = el("div", "s1c-chat");
    chat.setAttribute("lang", lang);

    /* Trust line: counter next to the guarantee copy. Skipped in embed
       mode; the hosting panel renders the single trust line. */
    var netCount = null;
    var title = null;
    if (!embed) {
      var trust = el("div", "s1c-trust");
      netCount = el("strong", "s1c-netcount", "0");
      trust.appendChild(netCount);
      trust.appendChild(el("span", null, " " + S.requestsSent + ". "));
      trust.appendChild(el("span", "s1c-trustcopy", S.trustCopy));
      trust.appendChild(el("span", "s1c-draftbadge", S.draftBadge));
      chat.appendChild(trust);

      title = el("h2", "s1c-title", S.chatTitle);
      title.tabIndex = -1;
      chat.appendChild(title);
      chat.appendChild(el("p", "s1c-lede", S.chatLede));
    }

    var log = el("ol", "s1c-log");
    log.setAttribute("role", "log");
    log.setAttribute("aria-live", "polite");
    log.setAttribute("aria-label", S.chatTitle);
    chat.appendChild(log);

    var input = el("div", "s1c-input");
    chat.appendChild(input);

    host.appendChild(chat);

    /* All counter writes go through window.__s1net.setNetCount so the
       element always holds a plain count string from the first paint. */
    function refreshNet() {
      if (!netCount) return; /* embed mode: the panel owns the counter */
      var w = (typeof window !== "undefined") ? window : RT();
      var api = w.__s1net;
      if (api && typeof api.setNetCount === "function") api.setNetCount(netCount);
      else netCount.textContent = "0";
    }
    refreshNet();

    function scrollDown() {
      try { log.scrollTop = log.scrollHeight; } catch (e) { /* ignore */ }
    }

    function botMsg(text, cls) {
      var li = el("li", "s1c-msg s1c-bot" + (cls ? " " + cls : ""));
      var bubble = el("div", "s1c-bubble", text);
      li.appendChild(bubble);
      log.appendChild(li);
      scrollDown();
      return li;
    }

    function botNode(node) {
      var li = el("li", "s1c-msg s1c-bot");
      li.appendChild(node);
      log.appendChild(li);
      scrollDown();
      return li;
    }

    function userMsg(text) {
      var li = el("li", "s1c-msg s1c-user");
      li.appendChild(el("div", "s1c-bubble", text));
      log.appendChild(li);
      scrollDown();
      return li;
    }

    function clearInput() {
      while (input.firstChild) input.removeChild(input.firstChild);
    }

    function chipLabel(chipId, opt) {
      if (chipId === "size") return opt;
      return (S[chipId + "Names"] || {})[opt] || opt;
    }

    function questionText(chipId) {
      return { size: S.chatAskSize, sector: S.chatAskSector, region: S.chatAskRegion, types: S.chatAskTypes }[chipId];
    }

    /* Chip buttons: real buttons with roving tabindex; arrows move,
       Enter/Space picks (native button behavior). */
    function renderChips(chipId, onPick) {
      clearInput();
      var chip = null;
      Tmpl.CHIPS.forEach(function (c) { if (c.id === chipId) chip = c; });
      var group = el("div", "s1c-chips");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", questionText(chipId));
      var btns = chip.options.map(function (opt, i) {
        var b = el("button", "s1c-chip", chipLabel(chipId, opt));
        b.type = "button";
        b.tabIndex = i === 0 ? 0 : -1;
        b.setAttribute("data-opt", opt);
        b.addEventListener("click", function () { onPick(opt); });
        group.appendChild(b);
        return b;
      });
      group.addEventListener("keydown", function (e) {
        var cur = btns.indexOf(document.activeElement);
        if (cur === -1) return;
        var next = -1;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (cur + 1) % btns.length;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (cur - 1 + btns.length) % btns.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = btns.length - 1;
        if (next !== -1) {
          e.preventDefault();
          btns.forEach(function (b, i) { b.tabIndex = i === next ? 0 : -1; });
          btns[next].focus();
        }
      });
      input.appendChild(group);
      if (btns[0]) btns[0].focus();
      return btns;
    }

    function actionRow(buttons) {
      clearInput();
      var row = el("div", "s1c-actions");
      buttons.forEach(function (spec) {
        var b = el("button", "btn" + (spec.secondary ? " secondary" : ""), spec.label);
        b.type = "button";
        b.addEventListener("click", spec.onClick);
        row.appendChild(b);
      });
      input.appendChild(row);
      var first = row.querySelector("button");
      if (first) first.focus();
      return row;
    }

    /* ---------------- flow stages ---------------- */

    function greet() {
      state.stage = "greet";
      botMsg(S.chatGreeting);
      askChip(0);
    }

    function askChip(i) {
      if (i >= CHIP_ORDER.length) { resolveTemplate(); return; }
      var chipId = CHIP_ORDER[i];
      state.stage = "q-" + chipId;
      state.qIndex = i;
      botMsg(questionText(chipId));
      renderChips(chipId, function (opt) {
        state.chips[chipId] = opt;
        userMsg(chipLabel(chipId, opt));
        askChip(i + 1);
      });
      showPasteToggle();
    }

    function showPasteToggle() {
      var t = el("button", "s1c-pastetoggle", S.chatOrPaste);
      t.type = "button";
      t.addEventListener("click", openPaste);
      input.appendChild(t);
    }

    function openPaste() {
      state.stage = "paste";
      clearInput();
      botMsg(S.chatPasteIntro);
      var wrap = el("div", "s1c-paste");
      var ta = document.createElement("textarea");
      ta.className = "s1c-textarea";
      ta.rows = 8;
      ta.placeholder = S.chatPastePlaceholder;
      ta.setAttribute("aria-label", S.chatPasteIntro);
      wrap.appendChild(ta);
      var row = el("div", "s1c-actions");
      var use = el("button", "btn", S.chatPasteUse);
      use.type = "button";
      use.addEventListener("click", function () {
        var res = validateRecipeText(ta.value, lang);
        if (!res.ok) {
          botMsg(res.message, "s1c-error");
          ta.focus();
          return;
        }
        state.recipe = res.recipe;
        userMsg(fill(S.chatPastedRecipe, { id: res.recipe.recipe_id }));
        botMsg(fill(S.chatRecipeValid, { name: res.recipe.name || res.recipe.recipe_id, n: res.recipe.items.length }));
        recipeReady();
      });
      var cancel = el("button", "btn secondary", S.back);
      cancel.type = "button";
      cancel.addEventListener("click", function () {
        /* Back restores the chips and prompt for the question the
           conversation is actually on (state.qIndex), keeping the
           answers already given. Never hardcoded to Q1. */
        state.recipe = null;
        askChip(state.qIndex);
      });
      row.appendChild(use);
      row.appendChild(cancel);
      wrap.appendChild(row);
      input.appendChild(wrap);
      ta.focus();
    }

    function resolveTemplate() {
      state.stage = "template";
      var problems = Tmpl.validateChips(state.chips);
      if (problems.length) {
        botMsg(S.chatErrBadChips, "s1c-error");
        state.chips = { size: null, sector: null, region: null, types: null };
        askChip(0);
        return;
      }
      var t = Tmpl.selectTemplate(state.chips);
      if (t) {
        state.recipe = t;
        templateMatched(t);
      } else {
        /* Safety net: all 384 chip vectors are authored, so selectTemplate
           only returns null on a corrupt table. */
        botMsg(S.templateMissing);
        botMsg(S.readyTemplates + ":");
        var row = el("div", "s1c-actions");
        clearInput();
        Tmpl.authoredTemplates().slice(0, 12).forEach(function (a) {
          var aname = (lang === "fr") ? I18n.templateName(a.chips, "fr") : a.name;
          var b = el("button", "btn secondary", aname);
          b.type = "button";
          b.addEventListener("click", function () {
            Object.keys(a.chips).forEach(function (cid) { state.chips[cid] = a.chips[cid]; });
            userMsg(aname);
            var full = Tmpl.selectTemplate(state.chips);
            state.recipe = full;
            templateMatched(full);
          });
          row.appendChild(b);
        });
        input.appendChild(row);
        var first = row.querySelector("button");
        if (first) first.focus();
      }
    }

    function templateLabels(recipe) {
      var labels = [];
      recipe.items.forEach(function (it) {
        if ((it.intent === "add_node" || it.intent === "add_collection_point") &&
            it.params && it.params.label) {
          labels.push(it.params.label);
        }
      });
      return labels;
    }

    function templateMatched(t) {
      /* FR composes from the localized chip names; the authored template
         names are English (2026-10-05). */
      var name = (lang === "fr") ? I18n.templateName(state.chips, "fr") : t.name;
      botMsg(fill(S.chatTemplateMatched, { name: name, n: t.items.length }));
      var labels = templateLabels(t);
      if (labels.length) botMsg(fill(S.chatTemplateNodes, { labels: labels.join(", ") }));
      recipeReady();
    }

    function recipeReady() {
      state.stage = "ready";
      actionRow([
        { label: S.startRun, onClick: runRecipe },
        { label: S.chatStartOver, secondary: true, onClick: reset }
      ]);
    }

    function reset() {
      try { H.reset(); } catch (e) { /* no session */ }
      state.chips = { size: null, sector: null, region: null, types: null };
      state.recipe = null;
      state.running = false;
      state.stopRequested = false;
      lockModes(false);
      clearInput();
      chat.hidden = false;
      greet();
      if (!embed && title) title.focus();
    }

    /* ---------------- run + narration ---------------- */

    /* The single panel locks its mode toggle while a run is live; the
       chatbot reports its own run state through the ui handle so the
       toggle cannot strand a live session. No-op without a ui handle. */
    function lockModes(locked) {
      if (uiHandle && typeof uiHandle.setModeLocked === "function") {
        try { uiHandle.setModeLocked(locked); } catch (e) { /* cosmetic */ }
      }
    }

    function paintCanvas() {
      try {
        var w = (typeof window !== "undefined") ? window : RT();
        if (w.DMImport && typeof w.DMImport.applyState === "function") {
          var st = H.state();
          w.DMImport.applyState({ nodes: st.nodes, edges: st.edges });
        }
      } catch (e) { /* canvas is best-effort choreography */ }
    }

    function narrateStep(step) {
      var ex = H.controller.executor();
      var ctx = {};
      var p = step.params || {};
      if (step.action_name === "add_node" || step.action_name === "add_collection_point") {
        ctx.label = p.label;
      } else if (step.action_name === "connect") {
        ctx.a_label = ex._nodes[p.a] ? ex._nodes[p.a].label : p.a;
        ctx.b_label = ex._nodes[p.b] ? ex._nodes[p.b].label : p.b;
      } else if (step.action_name === "set_field" || step.action_name === "set_retention" ||
                 step.action_name === "confirm_node") {
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

    function pauseOnFlag() {
      return new Promise(function (resolve) {
        var wrap = el("div", "s1c-bubble");
        wrap.appendChild(el("p", null, S.flagPaused));
        var btn = el("button", "btn", S.clearFlag);
        btn.type = "button";
        btn.addEventListener("click", function () {
          H.clearFlagAndContinue();
          btn.disabled = true;
          resolve();
        });
        wrap.appendChild(btn);
        botNode(wrap);
        btn.focus();
      });
    }

    /* The run goes through the single page seam
       window.execute_mapping_workflow (workflow.js): the chatbot authors
       the recipe and narrates; the seam owns ready/start/stepping. */
    async function runRecipe() {
      if (state.running || !state.recipe) return;
      var w = (typeof window !== "undefined") ? window : RT();
      var wf = w.execute_mapping_workflow;
      if (typeof wf !== "function") {
        console.error("[s1] chat: execute_mapping_workflow seam is not loaded.");
        botMsg(S.engineFailed, "s1c-error");
        return;
      }
      var live = null;
      try { live = H.state(); } catch (e) { live = null; }
      if (live && !live.done) {
        botMsg(S.chatBusy, "s1c-error");
        return;
      }
      state.running = true;
      state.stopRequested = false;
      lockModes(true);
      clearInput();
      var stopBtn = el("button", "btn secondary", S.stop);
      stopBtn.type = "button";
      stopBtn.addEventListener("click", function () {
        state.stopRequested = true;
        stopBtn.disabled = true;
      });
      input.appendChild(stopBtn);

      botMsg(S.loadingModel, "s1c-status");
      state.netTimer = setInterval(refreshNet, 1000);

      var res;
      var sawStep = false;
      var failPhase = null;
      try {
        res = await wf(state.recipe, {
          lang: lang,
          paceMs: PACE_MS,
          shouldStop: function () { return state.stopRequested; },
          onTicket: function (ticket) {
            botMsg(S.modelReady, "s1c-status");
            botMsg(fill(S.chatTicket, { id: ticket.session_id, recipe: ticket.recipe_id, n: ticket.items }));
            paintCanvas();
            refreshNet();
          },
          onStep: function (step) {
            sawStep = true;
            paintCanvas();
            botMsg(fill(S.chatStepPrefix, { n: step.step_index + 1 }) + " " + narrateStep(step));
            refreshNet();
          },
          onFlag: pauseOnFlag,
          onError: function (err, phase) {
            /* Engine or step failure: plain message in the chat,
               technical detail to the console only. */
            console.error("[s1] chat run failed (" + phase + "):", err);
            failPhase = phase;
            botMsg(phase === "step" ? S.stepFailed : S.engineFailed, "s1c-error");
          }
        });
      } catch (e) {
        /* surfaced via onError above */
      }
      if (state.netTimer) { clearInterval(state.netTimer); state.netTimer = null; }
      refreshNet();
      state.running = false;
      clearInput();
      if (!res && !sawStep && (failPhase === "ready" || failPhase === "start")) {
        /* The engine never got going: back to the ready state so the
           reader can retry, same as before the seam. */
        lockModes(false);
        recipeReady();
      } else if (!res || res.aborted) {
        lockModes(false);
        if (res && res.aborted) {
          var abTexts = Narr.narrate("abort_session",
            { reason: (res.abort && res.abort.reason) || "" }, null, {});
          botMsg(lang === "fr" ? abTexts.fr : abTexts.en, "s1c-status");
        }
        botMsg(S.stopped, "s1c-status");
        actionRow([{ label: S.chatStartOver, secondary: true, onClick: reset }]);
      } else {
        showHandoff();
      }
    }

    function showHandoff() {
      state.stage = "handoff";
      botMsg(S.runComplete, "s1c-status");
      botMsg(S.chatHandoffTitle);
      botMsg(S.chatHandoffBody);
      actionRow([
        {
          label: S.chatHandoffButton,
          onClick: function () {
            chat.hidden = true;
            var target = document.getElementById("s1-assistant");
            if (uiHandle && typeof uiHandle.enterReview === "function") {
              uiHandle.enterReview();
            }
            if (target) {
              try { target.scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) {
                target.scrollIntoView();
              }
            }
          }
        },
        { label: S.chatStartOver, secondary: true, onClick: reset }
      ]);
    }

    greet();
    return {
      state: state,
      reset: reset,
      validateRecipeText: validateRecipeText,
      show: function () { chat.hidden = false; },
      _host: host
    };
  }

  return {
    init: init,
    pure: {
      validateRecipeText: validateRecipeText,
      CHIP_ORDER: CHIP_ORDER,
      AUTHORING_INTENTS: Object.keys(AUTHORING_INTENTS),
      RECOVERY_INTENTS: Object.keys(RECOVERY_INTENTS)
    }
  };
});
