/**
 * narrate.js - step-log narration templates (EN + Quebec French).
 *
 * Every template comes from the executor domain contract (section 5);
 * placeholders in braces are filled from the action params and session
 * state, all other text is fixed. No em dashes, no stock phrasing.
 *
 * UMD: runs in browsers and Node. No network, no storage.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module !== null && typeof module.exports === "object") {
    module.exports = api;
  } else {
    root.S1Narrate = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var TYPE_FR = {
    collection: "nœud de collecte",
    system: "système",
    thirdparty: "tiers",
    destruction: "destruction"
  };
  var TYPE_ARTICLE_FR = {
    collection: "un point de collecte",
    system: "un système",
    thirdparty: "un tiers",
    destruction: "une destruction"
  };
  var CAT_FR = { contact: "contact", payment: "paiement", marketing: "marketing" };
  var FIELD_FR = { label: "nom", x: "position X", y: "position Y" };

  function fill(template, vars) {
    return template.replace(/\{([a-zA-Z_]+)\}/g, function (m, k) {
      return vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m;
    });
  }

  /**
   * Narrate one applied action. ctx carries resolved labels:
   * {label, a_label, b_label, type_fr, cat_fr, field_fr, detail, target}.
   * Returns {en, fr}.
   */
  function narrate(actionName, params, result, ctx) {
    ctx = ctx || {};
    var en = "", fr = "";
    switch (actionName) {
      case "add_node":
        en = fill("Added {label} as a {type} node.", { label: ctx.label, type: params.type });
        fr = fill("« {label} » ajouté comme {type_fr}.", { label: ctx.label, type_fr: TYPE_FR[params.type] || params.type });
        break;
      case "add_collection_point":
        en = fill("Added {label} as a collection point.", { label: ctx.label });
        fr = fill("« {label} » ajouté comme point de collecte.", { label: ctx.label });
        break;
      case "connect":
        en = fill("Connected {a_label} to {b_label} ({cat}).", { a_label: ctx.a_label, b_label: ctx.b_label, cat: params.cat });
        fr = fill("« {a_label} » connecté à « {b_label} » ({cat_fr}).", { a_label: ctx.a_label, b_label: ctx.b_label, cat_fr: CAT_FR[params.cat] || params.cat });
        break;
      case "set_field":
        en = fill("Changed {field} on {label} to {value}.", { field: params.field, label: ctx.label, value: params.value });
        fr = fill("« {field_fr} » de « {label} » changé à « {value} ».", { field_fr: FIELD_FR[params.field] || params.field, label: ctx.label, value: params.value });
        break;
      case "set_retention": {
        var label = ctx.label;
        if (params.verify_only === true) {
          en = fill("Flagged {record_type} on {label} for verification: no cited period.",
            { record_type: params.record_type, label: label });
          fr = fill("« {record_type} » sur « {label} » marqué à vérifier : aucune durée citée.",
            { record_type: params.record_type, label: label });
        } else {
          var anchorEn = params.anchor ? ", measured " + params.anchor + "," : "";
          var anchorFr = params.anchor ? ", à compter de " + params.anchor + "," : "";
          en = fill("Noted {min} to {max} years retention for {record_type} on {label}{anchor} per {statute}.",
            { min: params.range_min_years, max: params.range_max_years, record_type: params.record_type, label: label, anchor: anchorEn, statute: params.statute });
          fr = fill("Conservation de {min} à {max} ans notée pour « {record_type} » sur « {label} »{anchor} ({statute}).",
            { min: params.range_min_years, max: params.range_max_years, record_type: params.record_type, label: label, anchor: anchorFr, statute: params.statute });
        }
        break;
      }
      case "confirm_node": {
        var noteEn = params.note ? " Note: " + params.note + "." : "";
        var noteFr = params.note ? " Note : " + params.note + "." : "";
        en = "You confirmed " + ctx.label + "." + noteEn;
        fr = "« " + ctx.label + " » confirmé." + noteFr;
        break;
      }
      case "flag_for_review":
        en = fill("Flagged {target} for review: {reason}.", { target: ctx.target, reason: params.reason });
        fr = fill("« {target} » signalé pour révision : {reason}.", { target: ctx.target, reason: params.reason });
        break;
      case "run_check": {
        var report = (result && result.report) || {};
        var names = Object.keys(report);
        var passed = names.filter(function (n) { return report[n] && report[n].pass; }).length;
        en = fill("Ran checks ({checks}): {passed} of {total} passed.",
          { checks: params.checks.join(", "), passed: passed, total: params.checks.length });
        fr = fill("Vérifications lancées ({checks}) : {passed} sur {total} réussies.",
          { checks: params.checks.join(", "), passed: passed, total: params.checks.length });
        break;
      }
      case "export":
        en = "Downloaded the Excel inventory.";
        fr = "Inventaire Excel téléchargé.";
        break;
      case "skip_recipe_item":
        en = fill("Skipped step {item_index}: {reason}.", { item_index: params.item_index, reason: params.reason });
        fr = fill("Étape {item_index} sautée : {reason}.", { item_index: params.item_index, reason: params.reason });
        break;
      case "undo_last":
        en = fill("Undid {action_name}: {detail}.", { action_name: (result && result.undone_action) || "action", detail: ctx.detail || "" });
        fr = fill("« {action_name} » annulé : {detail}.", { action_name: (result && result.undone_action) || "action", detail: ctx.detail || "" });
        break;
      case "abort_session":
        en = fill("Stopped the session: {reason}.", { reason: params.reason });
        fr = fill("Session arrêtée : {reason}.", { reason: params.reason });
        break;
      default:
        en = "Applied " + actionName + ".";
        fr = "« " + actionName + " » appliqué.";
    }
    return { en: en, fr: fr };
  }

  /* Review prompt per artifact (domain contract 5, "Review prompt"). */
  function reviewPrompt(kind, ctx, lang) {
    var fr = lang === "fr";
    if (kind === "node") {
      var cat = fr ? TYPE_ARTICLE_FR[ctx.type] : articleEn(ctx.type);
      return fr
        ? fill("« {label} » est placé ici comme {category_fr}. C'est bien ça ?", { label: ctx.label, category_fr: cat })
        : fill("I put {label} here as {category}. Right?", { label: ctx.label, category: cat });
    }
    /* edge */
    var flow = fr
      ? fill("flux {cat_fr} de « {a_label} » vers « {b_label} »", { cat_fr: CAT_FR[ctx.cat] || ctx.cat, a_label: ctx.a_label, b_label: ctx.b_label })
      : fill("{cat} flow from {a_label} to {b_label}", { cat: ctx.cat, a_label: ctx.a_label, b_label: ctx.b_label });
    return fr
      ? fill("Ce lien est un {category_fr}. C'est bien ça ?", { category_fr: flow })
      : fill("I drew this as {category}. Right?", { category: flow });
  }

  function articleEn(type) {
    return { collection: "a collection point", system: "a system", thirdparty: "a third party", destruction: "a destruction point" }[type] || type;
  }

  /* Correction confirmation (domain contract 5). */
  function correctionConfirm(kind, ctx, lang) {
    var fr = lang === "fr";
    if (kind === "retype") {
      return fr
        ? fill("Corrigé : « {label} » est maintenant {category_fr}.", { label: ctx.label, category_fr: TYPE_ARTICLE_FR[ctx.type] })
        : fill("Fixed: {label} is now {category}.", { label: ctx.label, category: articleEn(ctx.type) });
    }
    if (kind === "relabel") {
      return fr
        ? fill("Corrigé : nommer « {label} ».", { label: ctx.label })
        : fill("Fixed: labeled {label}.", { label: ctx.label });
    }
    if (kind === "move") {
      return fr ? "Corrigé : déplacé à la nouvelle position." : "Fixed: moved to the new position.";
    }
    if (kind === "reconnect") {
      return fr
        ? fill("Corrigé : reconnecté à « {b_label} ».", { b_label: ctx.b_label })
        : fill("Fixed: reconnected to {b_label}.", { b_label: ctx.b_label });
    }
    return fr ? "Corrigé." : "Fixed.";
  }

  return {
    narrate: narrate,
    reviewPrompt: reviewPrompt,
    correctionConfirm: correctionConfirm,
    TYPE_FR: TYPE_FR,
    CAT_FR: CAT_FR
  };
});
