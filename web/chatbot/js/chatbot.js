/**
 * chatbot.js - deterministic conversational intake for the System-1 executor.
 *
 * The chat is the persistent assistant across the whole flow, not a mode
 * beside it: one panel stays mounted from intake through build narration,
 * review help, and post-map refinement. The quick 4-tap intake is the
 * chat's opening message with answer chips (4 taps then build, zero
 * typing). Guided questions continue in the same panel. After the map is
 * built, the chat moves out of the mode chrome (which the review screen
 * hides) into the panel itself, offers review help, and accepts
 * deterministic refinement commands in English and Quebec French
 * (add/rename/remove items and flows, gap analysis, start over).
 * Destructive ops always confirm in-chat first. Post-run mutations go
 * through H.applyCorrection (window.__s1executor.hooks.applyCorrection);
 * the canvas repaints via DMImport and the results/export read fresh
 * executor state.
 *
 * A pasted recipe JSON is the alternate path: it is validated structurally
 * (deterministic, zero tokens) and rejected with a plain-language message
 * naming the problem. The chatbot never executes; it authors recipes and
 * narrates. The executor does the running.
 *
 * Embed mode (opts.embed): the chatbot mounts inside the single S1UI panel
 * (one assistant, one panel). The standalone trust line, title, and lede
 * are skipped because the panel already renders one of each; engine
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

  /* ---------------- refinement intents (pure, DOM-free) ----------------
     Deterministic pattern parsing for post-map refinement commands,
     English + Quebec French. No LLM, no network, no storage.
       parseRefineIntent(text) -> parsed intent descriptor.
       resolveName(name, nodes) -> {status:"ok", id} |
         {status:"ambiguous", ids} | {status:"none", close:[labels]}.
       gapAnalysis(state) -> [{key, vars}] over {nodes, edges, annotations}.
       planRefine(parsed, state, lang) -> an execution plan the DOM layer
         carries out. Destructive ops always come back as action "confirm";
         nothing is applied without the in-chat Yes. */

  var REFINE_STRINGS = {
    en: {
      refineHelp: "Which item looks wrong? Tell me and I will fix it.",
      refinePlaceholder: "Type a change, for example: add our CRM as a system",
      refineSend: "Send",
      refineEx1: "Add our CRM as a system",
      refineEx2: "What is missing from my map?",
      refineEx3: "Add a flow from the website to the CRM",
      chatUnknown: "I did not catch that. I can add, rename, or remove items and flows, or tell you what is missing. Try one of these:",
      chatNoMap: "There is no map to change yet. Build one first, then tell me what to fix.",
      chatYes: "Yes",
      chatNo: "No",
      chatKept: "Kept it. Nothing changed.",
      chatAddedNode: "Added {label} as {type}.",
      chatAddedNodeGuessed: "Added {label}. I was not sure what kind of item it is, so I made it {type}.",
      chatRemovedEdgeAsk: "Remove the flow from {a} to {b}?",
      chatRemovedNodeAsk: "Remove {label}? Its flows go with it.",
      chatRemovedEdgeDone: "Removed the flow from {a} to {b}.",
      chatRemovedNodeDone: "Removed {label}.",
      chatRelabeled: "Renamed {old} to {new}.",
      chatRetyped: "Changed {label} to {type}.",
      chatAddedEdge: "Added a {cat} flow from {a} to {b}.",
      chatAskCat: "What kind of data flows from {a} to {b}?",
      chatAskType: "What kind of item is {label}?",
      chatAmbiguous: "Which one do you mean?",
      chatNotFound: "I could not find {name} on the map.",
      chatCloseNames: "Closest matches: {names}.",
      chatNoEdge: "I found no flow involving {name}.",
      chatNoEdgeBetween: "I found no flow between {a} and {b}.",
      chatDupEdge: "There is already a flow between {a} and {b}.",
      chatOpFailed: "I could not apply that change. Nothing was modified.",
      chatGapTitle: "Here is what looks unfinished:",
      chatGapNone: "Nothing jumps out. Every item has a flow, and every system or third party has a retention note.",
      gapNoFlow: "{label} has no flows yet. Say 'add a flow from {label} to ...' and I will draw it.",
      gapNoCat: "The flow from {a} to {b} has no category. Remove it and re-add it with a category.",
      gapUnconfirmed: "{label} is not confirmed yet. Confirm it in the review list when it looks right.",
      gapNoDestruction: "No secure-destruction point on the map. Say 'add Secure shredding as a destruction point' and I will add one.",
      gapNoRetention: "{label} has no retention note. Add one from its review card.",
      typeArticle: {
        collection: "a collection point", system: "a system",
        thirdparty: "a third party", destruction: "a secure destruction point"
      },
      typeName: {
        collection: "Collection point", system: "System",
        thirdparty: "Third party", destruction: "Secure destruction"
      },
      catName: { contact: "Contact", payment: "Payment", marketing: "Marketing" }
    },
    fr: {
      refineHelp: "Quel élément semble incorrect? Dites-le-moi et je vais le corriger.",
      refinePlaceholder: "Écrivez un changement, par exemple : ajoute notre CRM comme système",
      refineSend: "Envoyer",
      refineEx1: "Ajoute notre CRM comme système",
      refineEx2: "Qu’est-ce qui manque à ma carte?",
      refineEx3: "Ajoute un flux du site web vers le CRM",
      chatUnknown: "Je n’ai pas compris. Je peux ajouter, renommer ou retirer des éléments et des flux, ou vous dire ce qui manque. Essayez un de ceux-ci :",
      chatNoMap: "Il n’y a pas encore de carte à modifier. Construisez-en une d’abord, puis dites-moi quoi corriger.",
      chatYes: "Oui",
      chatNo: "Non",
      chatKept: "Conservé. Rien n’a changé.",
      chatAddedNode: "« {label} » ajouté comme {type}.",
      chatAddedNodeGuessed: "« {label} » ajouté. Je n’étais pas certain du type d’élément, alors j’en ai fait {type}.",
      chatRemovedEdgeAsk: "Retirer le flux de {a} vers {b}?",
      chatRemovedNodeAsk: "Retirer « {label} »? Ses flux seront retirés aussi.",
      chatRemovedEdgeDone: "Flux de {a} vers {b} retiré.",
      chatRemovedNodeDone: "« {label} » retiré.",
      chatRelabeled: "« {old} » renommé en « {new} ».",
      chatRetyped: "« {label} » est maintenant {type}.",
      chatAddedEdge: "Flux ajouté de {a} vers {b} (catégorie : {cat}).",
      chatAskCat: "Quel type de données circule de {a} vers {b}?",
      chatAskType: "Quel type d’élément est « {label} »?",
      chatAmbiguous: "Lequel voulez-vous dire?",
      chatNotFound: "Je n’ai pas trouvé « {name} » sur la carte.",
      chatCloseNames: "Ressemblances : {names}.",
      chatNoEdge: "Je n’ai trouvé aucun flux lié à « {name} ».",
      chatNoEdgeBetween: "Je n’ai trouvé aucun flux entre {a} et {b}.",
      chatDupEdge: "Il y a déjà un flux entre {a} et {b}.",
      chatOpFailed: "Je n’ai pas pu appliquer ce changement. Rien n’a été modifié.",
      chatGapTitle: "Voici ce qui semble inachevé :",
      chatGapNone: "Rien ne me saute aux yeux. Chaque élément a un flux, et chaque système ou tiers a une note de conservation.",
      gapNoFlow: "« {label} » n’a encore aucun flux. Dites « ajoute un flux de {label} vers … » et je vais le tracer.",
      gapNoCat: "Le flux de {a} vers {b} n’a pas de catégorie. Retirez-le et ajoutez-le de nouveau avec une catégorie.",
      gapUnconfirmed: "« {label} » n’est pas encore confirmé. Confirmez-le dans la liste de révision quand il vous semble juste.",
      gapNoDestruction: "Aucun point de destruction sécurisée sur la carte. Dites « ajoute Déchiquetage sécurisé comme point de destruction » et je vais l’ajouter.",
      gapNoRetention: "« {label} » n’a pas de note de conservation. Ajoutez-en une depuis sa fiche de révision.",
      typeArticle: {
        collection: "un point de collecte", system: "un système",
        thirdparty: "un tiers", destruction: "un point de destruction sécurisée"
      },
      typeName: {
        collection: "Point de collecte", system: "Système",
        thirdparty: "Tiers", destruction: "Destruction sécurisée"
      },
      catName: { contact: "contact", payment: "paiement", marketing: "marketing" }
    }
  };

  function refineStrings(lang) {
    return REFINE_STRINGS[lang === "fr" ? "fr" : "en"];
  }

  function refineMsg(key, vars, lang) {
    var S = refineStrings(lang);
    var t = S[key];
    if (t === undefined || t === null || typeof t === "object") return "";
    return fill(String(t), vars || {});
  }

  function normText(s) {
    return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function stripQuotes(s) {
    return String(s || "").replace(/^["'«»“”]+|["'«»“”]+$/g, "").trim();
  }

  var LEAD_ARTICLES = ["our", "my", "the", "a", "an", "notre", "nos", "mon", "ma", "mes",
    "le", "la", "les", "un", "une", "des", "du", "de la"];

  function stripArticles(s) {
    var t = String(s || "").trim();
    var changed = true;
    while (changed) {
      changed = false;
      var low = t.toLowerCase();
      for (var i = 0; i < LEAD_ARTICLES.length; i++) {
        var a = LEAD_ARTICLES[i];
        if (low === a || low.indexOf(a + " ") === 0) {
          t = t.slice(a.length).trim();
          low = t.toLowerCase();
          changed = true;
          break;
        }
      }
    }
    return t;
  }

  function detectType(text) {
    var t = normText(text);
    if (!t) return null;
    if (/(third party|third-party|thirdparty|\btiers\b|tierce)/.test(t)) return "thirdparty";
    if (/(destruction|déchiquetage|suppression sécurisée|secure deletion|shred)/.test(t)) return "destruction";
    if (/(collection|collecte|\bform\b|formulaire|sign-?up|inscription)/.test(t)) return "collection";
    if (/(system|syst[eè]me|\bcrm\b|database|base de donn|warehouse|entrep)/.test(t)) return "system";
    return null;
  }

  function detectCat(text) {
    var t = normText(text);
    if (/\b(paiement|payment|pay)\b/.test(t)) return "payment";
    if (/\bmarketing\b/.test(t)) return "marketing";
    if (/\b(contact|coordonn|identit)/.test(t)) return "contact";
    return null;
  }

  /* "from X to Y" / "de X vers Y" / "de X à Y", with articles stripped.
     Returns {a, b} or null. */
  function parseFromTo(s) {
    var m = String(s || "").match(/\bfrom\s+(.+?)\s+to\s+(.+)$/i);
    if (m) {
      var a = stripArticles(stripQuotes(m[1]));
      var b = stripArticles(stripQuotes(m[2]));
      if (a && b) return { a: a, b: b };
    }
    var f = String(s || "").match(/\bde\s+(.+?)\s+(?:vers|à|a)\s+(.+)$/i);
    if (f) {
      var fa = stripArticles(stripQuotes(f[1]));
      var fb = stripArticles(stripQuotes(f[2]));
      if (fa && fb) return { a: fa, b: fb };
    }
    return null;
  }

  /* "X to Y" without "from" (connect phrasing), and the FR "X à Y"
     ("au"/"aux" included). */
  function parseToPair(s) {
    var m = String(s || "").match(/^(.+?)\s+to\s+(.+)$/i);
    if (m) {
      var a = stripArticles(stripQuotes(m[1]));
      var b = stripArticles(stripQuotes(m[2]));
      if (a && b) return { a: a, b: b };
    }
    var f = String(s || "").match(/^(.+?)\s+(?:vers|à|au[x]?|a)\s+(.+)$/i);
    if (f) {
      var fa = stripArticles(stripQuotes(f[1]));
      var fb = stripArticles(stripQuotes(f[2]));
      if (fa && fb) return { a: fa, b: fb };
    }
    return null;
  }

  function stripFlowWords(s) {
    var t = stripQuotes(s);
    t = t.replace(/\b(the|a|an|le|la|les|un|une|des)\b/gi, " ");
    t = t.replace(/\b(flows?|flux)\b/gi, " ");
    return stripArticles(t.replace(/\s+/g, " ").trim());
  }

  /**
   * Deterministic refinement-command parser. Both languages are tried on
   * every input; the reply language comes from the chat's lang, not from
   * what the user typed.
   */
  function parseRefineIntent(text) {
    var raw = String(text || "");
    var t = normText(raw);
    if (!t) return { intent: "empty" };

    if (/\bstart over\b/.test(t) || /\bwipe everything\b/.test(t) ||
        /\brecommencer\b/.test(t) || /\btout effacer\b/.test(t)) {
      return { intent: "start_over" };
    }
    if (/what'?s missing|what is missing|\bgaps?\b/.test(t) ||
        /qu['’]est-ce qui manque|que manque|il manque quoi/.test(t)) {
      return { intent: "gap" };
    }
    if (/^(help|aide)\b/.test(t) || /what can you do|que peux-tu faire/.test(t)) {
      return { intent: "help" };
    }

    var m, parts;
    /* rename X to Y / renomme X en Y */
    if ((m = raw.match(/^(?:rename|renomme|renommer)\b\s*(.+)$/i))) {
      parts = m[1].split(/\s+to\s+|\sen\s+/i);
      if (parts.length >= 2) {
        var to = stripQuotes(parts.slice(1).join(" "));
        var from = stripArticles(stripQuotes(parts[0]));
        if (from && to) return { intent: "relabel", from: from, to: to };
      }
      return { intent: "unknown" };
    }
    /* change X to a third party / change X en tiers. Without a "to",
       the name alone still parses and the type is asked with chips. */
    if ((m = raw.match(/^(?:change|make|changer|fais|faire)\b\s*(.+)$/i))) {
      parts = m[1].split(/\s+to\s+|\sen\s+/i);
      var cname = stripArticles(stripQuotes(parts[0]));
      if (!cname) return { intent: "unknown" };
      var ctype = parts.length >= 2 ? detectType(parts.slice(1).join(" ")) : null;
      return { intent: "retype", name: cname, type: ctype };
    }
    /* remove ... (edge first: flow keyword or from/to wins) */
    if ((m = raw.match(/^(?:remove|delete|retire|retirer|supprime|supprimer)\b\s*(.+)$/i))) {
      var rest = m[1];
      var rt = normText(rest);
      var ft = parseFromTo(rest);
      if (/\b(flows?|flux)\b/.test(rt) || ft) {
        if (ft) return { intent: "remove_edge", a: ft.a, b: ft.b };
        var fname = stripFlowWords(rest);
        if (fname) return { intent: "remove_edge", name: fname };
        return { intent: "unknown" };
      }
      var nname = stripArticles(stripQuotes(rest));
      if (nname) return { intent: "remove_node", name: nname };
      return { intent: "unknown" };
    }
    /* add ... (flow first, then node) */
    if ((m = raw.match(/^(?:add|ajoute|ajouter)\b\s*(.+)$/i))) {
      var arest = m[1];
      var art = normText(arest);
      var aft = parseFromTo(arest);
      if (/\b(flows?|flux)\b/.test(art) || aft) {
        if (!aft) return { intent: "unknown" };
        return { intent: "add_edge", a: aft.a, b: aft.b, cat: detectCat(arest) };
      }
      /* "add X to Y" with no flow and no "from" is ambiguous: ask for a
         clearer phrasing instead of adding a node literally named so. */
      if (/\bto\b/.test(art) || /\bvers\b/.test(art) || /[à]/.test(arest) ||
          /\bau[x]?\b/.test(art)) return { intent: "unknown" };
      /* "called"/"nommé" puts the name after the verb phrase:
         "add a collection point called Website form". */
      var aname = null, atype = null, guessed = false;
      var called = arest.split(/\s+called\s+|\s+nomm[eé]e?\s+/i);
      if (called.length > 1) {
        aname = stripArticles(stripQuotes(called.slice(1).join(" ")));
        atype = detectType(called[0]);
      } else {
        var asp = arest.split(/\s+as\s+|\s+comme\s+/i);
        aname = stripArticles(stripQuotes(asp[0]));
        if (asp.length > 1) atype = detectType(asp.slice(1).join(" "));
      }
      if (!aname) return { intent: "unknown" };
      if (!atype) atype = detectType(aname);
      if (!atype) { atype = "system"; guessed = true; }
      return { intent: "add_node", label: aname, type: atype, typeGuessed: guessed };
    }
    /* connect X to Y / connecte X à Y / relie X à Y */
    if ((m = raw.match(/^(?:connect|connecte|connecter|relie|relier)\b\s*(.+)$/i))) {
      var cft = parseFromTo(m[1]) || parseToPair(m[1]);
      if (cft) return { intent: "add_edge", a: cft.a, b: cft.b, cat: detectCat(m[1]) };
      return { intent: "unknown" };
    }
    return { intent: "unknown" };
  }

  function labelOf(nodes, id) {
    return (nodes[id] && nodes[id].label) || String(id);
  }

  /**
   * Case-insensitive label resolution against live executor nodes.
   * Exact match wins; one substring match wins; several become an
   * ambiguity for chips; none reports close (shared-word) names.
   */
  function resolveName(name, nodes) {
    var q = normText(name);
    var ids = Object.keys(nodes || {});
    var exact = [], sub = [];
    ids.forEach(function (id) {
      var l = normText(labelOf(nodes, id));
      if (l === q) exact.push(id);
      else if (l.indexOf(q) !== -1 || q.indexOf(l) !== -1) sub.push(id);
    });
    if (exact.length === 1) return { status: "ok", id: exact[0] };
    if (exact.length > 1) return { status: "ambiguous", ids: exact };
    if (sub.length === 1) return { status: "ok", id: sub[0] };
    if (sub.length > 1) return { status: "ambiguous", ids: sub };
    var qw = q.split(" ");
    var close = ids.filter(function (id) {
      var lw = normText(labelOf(nodes, id)).split(" ");
      return lw.some(function (w) { return w.length > 2 && qw.indexOf(w) !== -1; });
    });
    return {
      status: "none",
      close: close.slice(0, 6).map(function (id) { return labelOf(nodes, id); })
    };
  }

  function findEdge(edges, a, b) {
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return e;
    }
    return null;
  }

  /**
   * Deterministic gap analysis over executor state. Every gap carries the
   * words to say to fix it, so the reply is a short actionable list.
   */
  function gapAnalysis(st) {
    var gaps = [];
    var nodes = (st && st.nodes) || {};
    var edges = (st && st.edges) || [];
    var anns = (st && st.annotations) || [];
    var ids = Object.keys(nodes);
    var touched = {};
    edges.forEach(function (e) { touched[e.a] = 1; touched[e.b] = 1; });
    var confirmed = {}, retention = {};
    anns.forEach(function (a) {
      if (a.kind === "confirmation") confirmed[a.node_id] = 1;
      else if (a.kind === "retention") retention[a.node_id] = 1;
    });
    var CATS = ["contact", "payment", "marketing"];
    ids.forEach(function (id) {
      if (!touched[id]) gaps.push({ key: "gapNoFlow", vars: { label: labelOf(nodes, id) } });
    });
    edges.forEach(function (e) {
      if (CATS.indexOf(e.cat) === -1) {
        gaps.push({ key: "gapNoCat", vars: { a: labelOf(nodes, e.a), b: labelOf(nodes, e.b) } });
      }
    });
    ids.forEach(function (id) {
      if (!confirmed[id]) gaps.push({ key: "gapUnconfirmed", vars: { label: labelOf(nodes, id) } });
    });
    var hasDestr = ids.some(function (id) { return nodes[id].type === "destruction"; });
    if (!hasDestr) gaps.push({ key: "gapNoDestruction", vars: {} });
    ids.forEach(function (id) {
      var tp = nodes[id].type;
      if ((tp === "system" || tp === "thirdparty") && !retention[id]) {
        gaps.push({ key: "gapNoRetention", vars: { label: labelOf(nodes, id) } });
      }
    });
    return gaps;
  }

  function gapLines(gaps, lang) {
    var L = lang === "fr" ? "fr" : "en";
    return gaps.map(function (g) { return fill(REFINE_STRINGS[L][g.key] || "", g.vars); });
  }

  /* Plan builders shared by planRefine and the DOM chip continuations. */

  function planRemoveEdgeConfirm(st, edge, lang) {
    var L = lang === "fr" ? "fr" : "en";
    var vars = { a: labelOf(st.nodes, edge.a), b: labelOf(st.nodes, edge.b) };
    return {
      action: "confirm",
      op: { op: "remove_edge", a: edge.a, b: edge.b },
      askKey: "chatRemovedEdgeAsk", askVars: vars,
      doneKey: "chatRemovedEdgeDone", doneVars: vars
    };
  }

  function planRemoveNodeConfirm(st, id, lang) {
    var label = labelOf(st.nodes, id);
    return {
      action: "confirm",
      op: { op: "remove_node", node_id: id },
      askKey: "chatRemovedNodeAsk", askVars: { label: label },
      doneKey: "chatRemovedNodeDone", doneVars: { label: label }
    };
  }

  function planAddEdgeApply(st, a, b, cat, lang) {
    var RS = refineStrings(lang);
    return {
      action: "apply",
      op: { op: "add_edge", a: a, b: b, cat: cat },
      replyKey: "chatAddedEdge",
      replyVars: {
        a: labelOf(st.nodes, a), b: labelOf(st.nodes, b),
        cat: (RS.catName || {})[cat] || cat
      }
    };
  }

  function planRetypeApply(st, id, type, lang) {
    var RS = refineStrings(lang);
    return {
      action: "apply",
      op: { op: "retype", node_id: id, type: type },
      replyKey: "chatRetyped",
      replyVars: {
        label: labelOf(st.nodes, id),
        type: (RS.typeArticle || {})[type] || type
      }
    };
  }

  function notFoundPlan(name, res, lang) {
    var plan = { action: "error", key: "chatNotFound", vars: { name: name } };
    if (res && res.close && res.close.length) {
      plan.appendKey = "chatCloseNames";
      plan.appendVars = { names: res.close.join(", ") };
    }
    return plan;
  }

  function disambigPlan(field, res, parsed, st, lang) {
    return {
      action: "ask",
      askKey: "chatAmbiguous", askVars: {},
      options: res.ids.map(function (id) {
        var l = labelOf(st.nodes, id);
        return { value: l, label: l };
      }),
      resume: { kind: "disambig", field: field, parsed: parsed }
    };
  }

  /**
   * Turn a parsed intent plus live state into an execution plan.
   * Pure: no DOM, no executor calls. Destructive intents return
   * action "confirm" (the DOM layer asks in-chat); nothing here applies.
   */
  function planRefine(parsed, st, lang) {
    var L = lang === "fr" ? "fr" : "en";
    var RS = refineStrings(lang);
    switch (parsed.intent) {
      case "empty": return { action: "none" };
      case "unknown": return { action: "unknown" };
      case "help": return { action: "unknown" };
      case "start_over": return { action: "startover" };
      case "gap": {
        if (!st) return { action: "nomap" };
        return { action: "gap", gaps: gapAnalysis(st).slice(0, 8) };
      }
      case "add_node": {
        if (!st) return { action: "nomap" };
        return {
          action: "apply",
          op: { op: "add_node", type: parsed.type, label: parsed.label },
          replyKey: parsed.typeGuessed ? "chatAddedNodeGuessed" : "chatAddedNode",
          replyVars: {
            label: parsed.label,
            type: (RS.typeArticle || {})[parsed.type] || parsed.type
          }
        };
      }
      case "relabel": {
        if (!st) return { action: "nomap" };
        var rr = resolveName(parsed.from, st.nodes);
        if (rr.status === "ambiguous") return disambigPlan("from", rr, parsed, st, L);
        if (rr.status !== "ok") return notFoundPlan(parsed.from, rr, L);
        return {
          action: "apply",
          op: { op: "relabel", node_id: rr.id, label: parsed.to },
          replyKey: "chatRelabeled",
          replyVars: { old: labelOf(st.nodes, rr.id), new: parsed.to }
        };
      }
      case "retype": {
        if (!st) return { action: "nomap" };
        var rt = resolveName(parsed.name, st.nodes);
        if (rt.status === "ambiguous") return disambigPlan("name", rt, parsed, st, L);
        if (rt.status !== "ok") return notFoundPlan(parsed.name, rt, L);
        if (!parsed.type) {
          return {
            action: "ask",
            askKey: "chatAskType", askVars: { label: labelOf(st.nodes, rt.id) },
            options: ["collection", "system", "thirdparty", "destruction"].map(function (tp) {
              return { value: tp, label: (RS.typeName || {})[tp] || tp };
            }),
            resume: { kind: "retype", id: rt.id }
          };
        }
        return planRetypeApply(st, rt.id, parsed.type, L);
      }
      case "remove_node": {
        if (!st) return { action: "nomap" };
        var rn = resolveName(parsed.name, st.nodes);
        if (rn.status === "ambiguous") return disambigPlan("name", rn, parsed, st, L);
        if (rn.status !== "ok") return notFoundPlan(parsed.name, rn, L);
        return planRemoveNodeConfirm(st, rn.id, L);
      }
      case "remove_edge": {
        if (!st) return { action: "nomap" };
        if (parsed.a && parsed.b) {
          var ra = resolveName(parsed.a, st.nodes);
          var rb = resolveName(parsed.b, st.nodes);
          if (ra.status === "ambiguous") return disambigPlan("a", ra, parsed, st, L);
          if (rb.status === "ambiguous") return disambigPlan("b", rb, parsed, st, L);
          if (ra.status !== "ok") return notFoundPlan(parsed.a, ra, L);
          if (rb.status !== "ok") return notFoundPlan(parsed.b, rb, L);
          var edge = findEdge(st.edges, ra.id, rb.id);
          if (!edge) {
            return {
              action: "error", key: "chatNoEdgeBetween",
              vars: { a: labelOf(st.nodes, ra.id), b: labelOf(st.nodes, rb.id) }
            };
          }
          return planRemoveEdgeConfirm(st, edge, L);
        }
        var re = resolveName(parsed.name, st.nodes);
        if (re.status === "ambiguous") return disambigPlan("name", re, parsed, st, L);
        if (re.status !== "ok") return notFoundPlan(parsed.name, re, L);
        var touching = st.edges.filter(function (e) { return e.a === re.id || e.b === re.id; });
        if (!touching.length) {
          return { action: "error", key: "chatNoEdge", vars: { name: labelOf(st.nodes, re.id) } };
        }
        if (touching.length > 1) {
          return {
            action: "ask",
            askKey: "chatAmbiguous", askVars: {},
            options: touching.map(function (e) {
              var k = e.a + ">" + e.b;
              var l = labelOf(st.nodes, e.a) + " → " + labelOf(st.nodes, e.b);
              return { value: k, label: l };
            }),
            resume: { kind: "edge-pick", edges: touching }
          };
        }
        return planRemoveEdgeConfirm(st, touching[0], L);
      }
      case "add_edge": {
        if (!st) return { action: "nomap" };
        var aa = resolveName(parsed.a, st.nodes);
        var ab = resolveName(parsed.b, st.nodes);
        if (aa.status === "ambiguous") return disambigPlan("a", aa, parsed, st, L);
        if (ab.status === "ambiguous") return disambigPlan("b", ab, parsed, st, L);
        if (aa.status !== "ok") return notFoundPlan(parsed.a, aa, L);
        if (ab.status !== "ok") return notFoundPlan(parsed.b, ab, L);
        if (findEdge(st.edges, aa.id, ab.id)) {
          return {
            action: "error", key: "chatDupEdge",
            vars: { a: labelOf(st.nodes, aa.id), b: labelOf(st.nodes, ab.id) }
          };
        }
        if (!parsed.cat) {
          return {
            action: "ask",
            askKey: "chatAskCat",
            askVars: { a: labelOf(st.nodes, aa.id), b: labelOf(st.nodes, ab.id) },
            options: ["contact", "payment", "marketing"].map(function (c) {
              return { value: c, label: (RS.catName || {})[c] || c };
            }),
            resume: { kind: "add_edge_cat", a: aa.id, b: ab.id }
          };
        }
        return planAddEdgeApply(st, aa.id, ab.id, parsed.cat, L);
      }
      default: return { action: "unknown" };
    }
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
      netTimer: null,
      /* Refinement: pending holds an unconfirmed destructive op;
         answering guards overlapping replies; slot is the chat's home
         element (the guided-mode slot) for the trip back from review. */
      pending: null,
      answering: false,
      painted: false,
      slot: null
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
    /* inputMain holds the per-stage controls (chips, action rows, the
       paste view); inputText holds the persistent refinement text row.
       clearInput only clears inputMain so the text row survives chip
       swaps during refinement. */
    var inputMain = el("div", "s1c-inputmain");
    var inputText = el("div", "s1c-inputtext");
    input.appendChild(inputMain);
    input.appendChild(inputText);
    chat.appendChild(input);

    host.appendChild(chat);
    state.slot = host;

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

    function reducedMotion() {
      try {
        if (typeof window !== "undefined" && window.matchMedia) {
          return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        }
      } catch (e) { /* ignore */ }
      return false;
    }

    function scrollDown(smooth) {
      try {
        if (smooth && !reducedMotion() && typeof log.scrollTo === "function") {
          log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
        } else {
          log.scrollTop = log.scrollHeight;
        }
      } catch (e) {
        try { log.scrollTop = log.scrollHeight; } catch (e2) { /* ignore */ }
      }
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

    /* Typing indicator before a deterministic reply: a brief, honest beat
       (380ms, 60ms under reduced motion) with three dots, then the real
       message replaces it. The indicator always resolves; there is no
       spinner state that can hang. */
    var TYPING_MS = 380;
    var TYPING_MS_REDUCED = 60;

    function typingLi(cls) {
      var li = el("li", "s1c-msg s1c-bot" + (cls ? " " + cls : ""));
      var bubble = el("div", "s1c-bubble s1c-typing");
      bubble.setAttribute("aria-label", S.assistantThinking);
      for (var i = 0; i < 3; i++) bubble.appendChild(el("span", "s1c-dot"));
      li.appendChild(bubble);
      log.appendChild(li);
      scrollDown(true);
      return { li: li, bubble: bubble };
    }

    function resolveTyping(t, cls, fillFn) {
      setTimeout(function () {
        t.bubble.className = "s1c-bubble";
        while (t.bubble.firstChild) t.bubble.removeChild(t.bubble.firstChild);
        fillFn(t.bubble);
        if (cls) t.li.className += " " + cls;
        scrollDown(true);
      }, reducedMotion() ? TYPING_MS_REDUCED : TYPING_MS);
    }

    /* say(text): post a bot reply after the typing beat. Returns a promise
       for the finished message element. */
    function say(text, cls) {
      var t = typingLi();
      return new Promise(function (resolve) {
        resolveTyping(t, cls, function (bubble) {
          bubble.textContent = text;
          resolve(t.li);
        });
      });
    }

    function sayNode(node, cls) {
      var t = typingLi();
      return new Promise(function (resolve) {
        resolveTyping(t, cls, function (bubble) {
          bubble.appendChild(node);
          resolve(t.li);
        });
      });
    }

    function userMsg(text) {
      var li = el("li", "s1c-msg s1c-user");
      li.appendChild(el("div", "s1c-bubble", text));
      log.appendChild(li);
      scrollDown();
      return li;
    }

    function clearInput() {
      while (inputMain.firstChild) inputMain.removeChild(inputMain.firstChild);
    }

    function chipLabel(chipId, opt) {
      if (chipId === "size") return opt;
      return (S[chipId + "Names"] || {})[opt] || opt;
    }

    function questionText(chipId) {
      return { size: S.chatAskSize, sector: S.chatAskSector, region: S.chatAskRegion, types: S.chatAskTypes }[chipId];
    }

    /* Chip buttons: real buttons with roving tabindex; arrows move,
       Enter/Space picks (native button behavior). renderFreeChips takes
       explicit {value, label} options so refinement flows (confirmations,
       disambiguation, category/type picks) reuse the quick-mode chip
       look and keyboard behavior. */
    function renderFreeChips(items, onPick, ariaLabel) {
      clearInput();
      var group = el("div", "s1c-chips");
      group.setAttribute("role", "group");
      if (ariaLabel) group.setAttribute("aria-label", ariaLabel);
      var btns = items.map(function (it, i) {
        var b = el("button", "s1c-chip", it.label);
        b.type = "button";
        b.tabIndex = i === 0 ? 0 : -1;
        b.setAttribute("data-opt", it.value);
        b.addEventListener("click", function () { onPick(it.value, it.label); });
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
      inputMain.appendChild(group);
      if (btns[0]) btns[0].focus();
      return btns;
    }

    function renderChips(chipId, onPick) {
      var chip = null;
      Tmpl.CHIPS.forEach(function (c) { if (c.id === chipId) chip = c; });
      var items = chip.options.map(function (opt) {
        return { value: opt, label: chipLabel(chipId, opt) };
      });
      return renderFreeChips(items, function (value) { onPick(value); }, questionText(chipId));
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
      inputMain.appendChild(row);
      var first = row.querySelector("button");
      if (first) first.focus();
      return row;
    }

    /* ---------------- flow stages ---------------- */

    /* The quick 4-tap intake is the chat's opening message: one greeting
       bubble carrying the first question, with its answer chips right
       below. Four taps then build, zero typing. */
    function greet() {
      state.stage = "greet";
      state.qIndex = 0;
      botMsg(S.chatGreeting + " " + S.chatAskSize);
      state.stage = "q-size";
      renderChips("size", function (opt) {
        state.chips.size = opt;
        userMsg(chipLabel("size", opt));
        askChip(1);
      });
      showPasteToggle();
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
      inputMain.appendChild(t);
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
      inputMain.appendChild(wrap);
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
      state.pending = null;
      state.answering = false;
      lockModes(false);
      clearInput();
      clearTextRow();
      /* Back to the guided-mode slot; restore the panel chrome the review
         screen hid. The canvas is cleared only if the assistant painted
         it, so a pre-run start-over never wipes the builder's nodes. */
      dockChat(false);
      restorePanelChrome();
      if (state.painted) { clearCanvasState(); state.painted = false; }
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
          state.painted = true;
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
      inputMain.appendChild(stopBtn);

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
        showRefineReady();
      }
    }

    /* ---------------- persistent refinement ----------------
       The chat is never remounted: the same .s1c-chat element travels.
       At review time it moves out of the mode chrome (which the review
       screen hides) into the panel itself, so it stays visible beside
       the review cards and, later, the results. #s1-panel and .s1-done
       are never renamed or removed (the page bridge watches them). */

    var panelEl = null; /* panel host captured when docking */

    function hasClass(node, cls) {
      return !!node && typeof node.className === "string" &&
        (" " + node.className + " ").indexOf(" " + cls + " ") !== -1;
    }

    /* Climb from the chat to the panel's mode wrapper (.s1-modes); its
       parent is the panel host that stays visible in every phase. */
    function panelHost() {
      var n = chat;
      while (n && !hasClass(n, "s1-modes")) n = n.parentNode;
      return (n && n.parentNode) || null;
    }

    /* Move the chat between its guided-mode slot and the panel level.
       Same element, never remounted. */
    function dockChat(docked) {
      try {
        if (docked) {
          var panel = panelHost();
          if (panel && chat.parentNode !== panel) {
            panel.appendChild(chat);
            panelEl = panel;
            if (!hasClass(chat, "s1c-docked")) chat.className += " s1c-docked";
          }
        } else if (state.slot && chat.parentNode !== state.slot) {
          state.slot.appendChild(chat);
          chat.className = (" " + chat.className + " ")
            .split(" ").filter(function (c) { return c && c !== "s1c-docked"; }).join(" ");
        }
      } catch (e) { /* the chat simply stays where it is */ }
    }

    /* Best-effort panel chrome restore for the chat's own start-over:
       show the mode chrome again, hide review/results. ui.js re-derives
       its review state on the next openReview. */
    function restorePanelChrome() {
      try {
        var panel = panelEl || panelHost();
        if (!panel || typeof panel.querySelectorAll !== "function") return;
        var modes = panel.querySelectorAll(".s1-modes");
        for (var i = 0; i < modes.length; i++) modes[i].hidden = false;
        var hide = panel.querySelectorAll(".s1-review, .s1-done");
        for (var j = 0; j < hide.length; j++) hide[j].hidden = true;
      } catch (e) { /* cosmetic */ }
    }

    function clearCanvasState() {
      try {
        var w = (typeof window !== "undefined") ? window : RT();
        if (w.DMImport && typeof w.DMImport.applyState === "function") {
          w.DMImport.applyState({ nodes: {}, edges: [] });
        }
      } catch (e) { /* canvas is best-effort choreography */ }
    }

    /* ---------------- refinement text row ---------------- */

    var textInputEl = null;

    function clearTextRow() {
      while (inputText.firstChild) inputText.removeChild(inputText.firstChild);
      textInputEl = null;
    }

    function focusTextInput() {
      try { if (textInputEl) textInputEl.focus(); } catch (e) { /* ignore */ }
    }

    function renderTextRow() {
      clearTextRow();
      var row = el("div", "s1c-textrow");
      var ti = document.createElement("input");
      ti.type = "text";
      ti.className = "s1c-textinput";
      var ph = refineMsg("refinePlaceholder", {}, lang);
      ti.placeholder = ph;
      ti.setAttribute("aria-label", ph);
      ti.autocomplete = "off";
      var send = el("button", "s1c-send", refineMsg("refineSend", {}, lang));
      send.type = "button";
      textInputEl = ti;
      function submit() {
        var v = ti.value.trim();
        if (!v) { try { ti.focus(); } catch (e) { /* ignore */ } return; }
        ti.value = "";
        handleRefine(v);
      }
      send.addEventListener("click", submit);
      ti.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
      });
      row.appendChild(ti);
      row.appendChild(send);
      inputText.appendChild(row);
    }

    /* Empty-state example prompts as tappable chips. */
    function renderExampleChips() {
      var items = ["refineEx1", "refineEx2", "refineEx3"].map(function (k) {
        var label = refineMsg(k, {}, lang);
        return { value: label, label: label };
      });
      renderFreeChips(items, function (value) { handleRefine(value); },
        refineMsg("refineHelp", {}, lang));
    }

    /* ---------------- refinement execution ---------------- */

    function liveState() {
      try {
        var st = H.state();
        if (!st || !st.nodes) return null;
        return { nodes: st.nodes, edges: st.edges || [], annotations: st.annotations || [] };
      } catch (e) { return null; }
    }

    /* Every applied correction repaints the canvas immediately and asks the
       panel to re-derive its review card list, so chat-driven edits show up
       in the visible cards at once. The results map/table and the Excel
       export read fresh executor state when they render, so they stay
       consistent. The chat narrates each change so nothing happens
       silently. */
    function applyRefineOp(op) {
      var res = H.applyCorrection(op);
      paintCanvas();
      if (uiHandle && typeof uiHandle.refreshReviewList === "function") {
        try { uiHandle.refreshReviewList(); } catch (e) { /* cards catch up on next render */ }
      }
      return res;
    }

    function runPlan(plan) {
      if (state.answering) return Promise.resolve();
      state.answering = true;
      var done = function () {
        state.answering = false;
        focusTextInput();
      };
      try {
        var p = executePlan(plan);
        if (p && typeof p.then === "function") return p.then(done, done);
      } catch (e) { /* fall through */ }
      done();
      return Promise.resolve();
    }

    function handleParsed(parsed) {
      runPlan(planRefine(parsed, liveState(), lang));
    }

    function handleRefine(text) {
      if (state.answering || state.stage !== "refine" || state.running) return;
      var t = normText(text);
      if (state.pending) {
        if (/^(yes|oui)\b/.test(t)) { userMsg(text); runPending(true); return; }
        if (/^(no|non)\b/.test(t)) { userMsg(text); runPending(false); return; }
        /* A new command cancels the unconfirmed destructive op; the op
           never ran, so dropping it is safe. */
        state.pending = null;
      }
      userMsg(text);
      handleParsed(parseRefineIntent(text));
    }

    function runPending(yes) {
      var plan = state.pending;
      state.pending = null;
      clearInput();
      if (state.answering) return;
      state.answering = true;
      var finish = function () { state.answering = false; focusTextInput(); };
      var p;
      if (!yes) {
        p = say(refineMsg("chatKept", {}, lang));
      } else {
        try {
          applyRefineOp(plan.op);
          p = say(refineMsg(plan.doneKey, plan.doneVars || {}, lang));
        } catch (e) {
          console.error("[s1] chat refinement failed:", e);
          p = say(refineMsg("chatOpFailed", {}, lang), "s1c-error");
        }
      }
      p.then(finish, finish);
    }

    function executePlan(plan) {
      if (!plan || plan.action === "none") return Promise.resolve();
      if (plan.action === "startover") { reset(); return Promise.resolve(); }
      if (plan.action === "nomap") {
        return say(refineMsg("chatNoMap", {}, lang), "s1c-error");
      }
      if (plan.action === "unknown") {
        return say(refineMsg("chatUnknown", {}, lang)).then(function () {
          renderExampleChips();
        });
      }
      if (plan.action === "gap") {
        var gaps = plan.gaps || [];
        if (!gaps.length) return say(refineMsg("chatGapNone", {}, lang));
        var wrap = el("div", "s1c-bubble");
        wrap.appendChild(el("p", null, refineMsg("chatGapTitle", {}, lang)));
        var ul = el("ul", "s1c-gaplist");
        gapLines(gaps, lang).forEach(function (line) {
          ul.appendChild(el("li", null, line));
        });
        wrap.appendChild(ul);
        return sayNode(wrap);
      }
      if (plan.action === "error") {
        var msg = refineMsg(plan.key, plan.vars || {}, lang);
        if (plan.appendKey) {
          msg += " " + refineMsg(plan.appendKey, plan.appendVars || {}, lang);
        }
        return say(msg, "s1c-error");
      }
      if (plan.action === "confirm") {
        state.pending = plan;
        var ask = refineMsg(plan.askKey, plan.askVars || {}, lang);
        return say(ask).then(function () {
          renderFreeChips([
            { value: "yes", label: refineMsg("chatYes", {}, lang) },
            { value: "no", label: refineMsg("chatNo", {}, lang) }
          ], function (value) { runPending(value === "yes"); }, ask);
        });
      }
      if (plan.action === "ask") {
        var resume = plan.resume || {};
        var askText = refineMsg(plan.askKey, plan.askVars || {}, lang);
        return say(askText).then(function () {
          renderFreeChips(plan.options || [], function (value) {
            var st = liveState();
            if (!st) { runPlan({ action: "nomap" }); return; }
            if (resume.kind === "add_edge_cat") {
              runPlan(planAddEdgeApply(st, resume.a, resume.b, value, lang));
            } else if (resume.kind === "retype") {
              runPlan(planRetypeApply(st, resume.id, value, lang));
            } else if (resume.kind === "edge-pick") {
              var parts = String(value).split(">");
              var edge = findEdge(st.edges, parts[0], parts[1]);
              if (edge) runPlan(planRemoveEdgeConfirm(st, edge, lang));
            } else if (resume.kind === "disambig") {
              var p2 = {};
              Object.keys(resume.parsed || {}).forEach(function (k) {
                p2[k] = resume.parsed[k];
              });
              p2[resume.field] = value;
              handleParsed(p2);
            }
          }, askText);
        });
      }
      if (plan.action === "apply") {
        try {
          applyRefineOp(plan.op);
          return say(refineMsg(plan.replyKey, plan.replyVars || {}, lang));
        } catch (e) {
          console.error("[s1] chat refinement failed:", e);
          return say(refineMsg("chatOpFailed", {}, lang), "s1c-error");
        }
      }
      return Promise.resolve();
    }

    function showRefineReady() {
      state.stage = "refine-ready";
      botMsg(S.runComplete, "s1c-status");
      botMsg(S.chatHandoffTitle);
      botMsg(S.chatHandoffBody);
      actionRow([
        {
          label: S.chatHandoffButton,
          onClick: function () { enterRefine(); }
        },
        { label: S.chatStartOver, secondary: true, onClick: reset }
      ]);
    }

    /* Review help: the chat joins the review screen instead of hiding.
       "Which item looks wrong? Tell me and I will fix it." Answers route
       into the same refinement intents. */
    function enterRefine() {
      if (state.stage !== "refine-ready") return;
      state.stage = "refine";
      clearInput();
      dockChat(true);
      if (uiHandle && typeof uiHandle.enterReview === "function") {
        try { uiHandle.enterReview(); } catch (e) { /* review is best-effort */ }
      }
      var target = document.getElementById("s1-assistant");
      if (target) {
        try { target.scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) {
          try { target.scrollIntoView(); } catch (e2) { /* ignore */ }
        }
      }
      say(refineMsg("refineHelp", {}, lang)).then(function () {
        renderExampleChips();
        renderTextRow();
      });
    }

    greet();
    return {
      state: state,
      reset: reset,
      validateRecipeText: validateRecipeText,
      show: function () { chat.hidden = false; },
      _host: host,
      _chat: chat,
      _showRefine: showRefineReady,
      _enterRefine: enterRefine
    };
  }

  return {
    init: init,
    pure: {
      validateRecipeText: validateRecipeText,
      CHIP_ORDER: CHIP_ORDER,
      AUTHORING_INTENTS: Object.keys(AUTHORING_INTENTS),
      RECOVERY_INTENTS: Object.keys(RECOVERY_INTENTS),
      parseRefineIntent: parseRefineIntent,
      resolveName: resolveName,
      gapAnalysis: gapAnalysis,
      gapLines: gapLines,
      planRefine: planRefine,
      planRemoveEdgeConfirm: planRemoveEdgeConfirm,
      planRemoveNodeConfirm: planRemoveNodeConfirm,
      planAddEdgeApply: planAddEdgeApply,
      planRetypeApply: planRetypeApply,
      refineMsg: refineMsg,
      REFINE_STRINGS: REFINE_STRINGS
    }
  };
});
