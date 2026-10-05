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
  var CAT_FR = { contact: "contact", payment: "paiement", marketing: "marketing" };
  var FIELD_FR = { label: "nom", x: "position X", y: "position Y" };

  /* Template-authored record types and item labels are English. French
     narration renders them through these maps so the chat build log
     never mixes languages. Vendor proper nouns (Salesforce, Stripe, ...)
     are intentionally absent and pass through unchanged, as does any
     label the reader typed themselves. */
  var RECORD_TYPE_FR = {
    "Service provider records": "Dossiers des fournisseurs de services",
    "Business records": "Dossiers d’entreprise",
    "Federal tax books and records": "Livres et dossiers fiscaux fédéraux",
    "Quebec tax books and records": "Livres et dossiers fiscaux du Québec",
    "Payment transaction records": "Dossiers des opérations de paiement",
    "Marketing consent records": "Dossiers de consentement marketing",
    "Customer account records": "Dossiers des comptes clients"
  };
  var LABEL_FR = {
    "Analytics platform": "Plateforme d’analyse",
    "Appointment booking form": "Formulaire de prise de rendez-vous",
    "Appointment scheduling system": "Système de planification des rendez-vous",
    "Billing platform": "Plateforme de facturation",
    "Card terminal provider": "Fournisseur de terminaux de paiement",
    "Click-and-collect order form": "Formulaire de commande avec ramassage en magasin",
    "Client intake form": "Formulaire d’admission client",
    "Client management system": "Système de gestion de la clientèle",
    "Clinic management system": "Système de gestion de clinique",
    "Cloud backup provider": "Fournisseur de sauvegarde infonuagique",
    "Cloud storage provider": "Fournisseur de stockage infonuagique",
    "Consultation booking form": "Formulaire de réservation de consultation",
    "Customer order form": "Formulaire de commande client",
    "Data warehouse": "Entrepôt de données",
    "Dealer portal provider": "Fournisseur du portail des concessionnaires",
    "Dealer signup form": "Formulaire d’inscription des concessionnaires",
    "Demo request form": "Formulaire de demande de démo",
    "Department file share": "Partage de fichiers du service",
    "Document storage provider": "Fournisseur de stockage de documents",
    "Donation form": "Formulaire de don",
    "Donation processor": "Processeur de dons",
    "Donor management system": "Système de gestion des donateurs",
    "Electronic health record system": "Système de dossiers de santé électroniques",
    "Email hosting provider": "Fournisseur d’hébergement de courriel",
    "Email marketing platform": "Plateforme de marketing par courriel",
    "Email newsletter platform": "Plateforme d’infolettre",
    "Example marketing platform": "Exemple de plateforme marketing",
    "Finance system": "Système financier",
    "Free trial signup form": "Formulaire d’inscription à l’essai gratuit",
    "HR records system": "Système des dossiers RH",
    "Identity provider": "Fournisseur d’identité",
    "Inventory management system": "Système de gestion des stocks",
    "Invoicing platform": "Plateforme de facturation",
    "Logistics tracking provider": "Fournisseur de suivi logistique",
    "Manufacturing execution system": "Système d’exécution de la fabrication",
    "Monitoring service": "Service de surveillance",
    "New patient registration form": "Formulaire d’inscription des nouveaux patients",
    "Newsletter signup form": "Formulaire d’inscription à l’infolettre",
    "Online checkout form": "Formulaire de commande en ligne",
    "POS terminal": "Terminal de point de vente",
    "Patient intake form": "Formulaire d’admission des patients",
    "Patient recall service": "Service de rappel des patients",
    "Payment processor": "Processeur de paiement",
    "Phone system provider": "Fournisseur de système téléphonique",
    "Point-of-sale system": "Système de point de vente",
    "Product database": "Base de données des produits",
    "Quote request form": "Formulaire de demande de soumission",
    "Secure cloud host": "Hébergeur infonuagique sécurisé",
    "Service request form": "Formulaire de demande de service",
    "Signup form": "Formulaire d’inscription",
    "Support ticketing system": "Système de billets d’assistance",
    "Trade credit service": "Service de crédit commercial",
    "Volunteer signup form": "Formulaire d’inscription des bénévoles"
  };
  function labelFr(label) {
    var l = String(label === undefined || label === null ? "" : label);
    return Object.prototype.hasOwnProperty.call(LABEL_FR, l) ? LABEL_FR[l] : l;
  }
  function recordTypeFr(rt) {
    var r = String(rt === undefined || rt === null ? "" : rt);
    return Object.prototype.hasOwnProperty.call(RECORD_TYPE_FR, r) ? RECORD_TYPE_FR[r] : r;
  }
  /* Indefinite-article type names for the correctionConfirm "retype"
     sentence ("est maintenant un système"). */
  var ARTICLE_FR = {
    collection: "un point de collecte",
    system: "un système",
    thirdparty: "un tiers",
    destruction: "une destruction"
  };

  /* Fail-closed placeholder fill for narration.
   *
   * Root cause of the review-screen bug (2026-10-05): reviewPrompt did a
   * NESTED fill. It first filled the inner template
   * "{cat} flow from {a_label} to {b_label}", then embedded that into
   * "I drew this as {category}. Right?". When the context lacked
   * cat/a_label/b_label, the inner fill returned the raw template (the old
   * code returned the match unchanged on a missing variable), and the
   * outer fill produced the leaked placeholder string verbatim.
   *
   * The fail-closed rule: a template must NEVER render with an unfilled
   * {placeholder}. A missing variable substitutes "" and fires a one-time
   * dev console warning naming the key, so the caller that forgot to
   * resolve a display value is visible during development while the
   * reader never sees template syntax. Callers resolve user-facing
   * fallbacks (labels, node ids) before calling fill; "" is the last
   * resort, not the display strategy. */
  var _warnedKeys = {};
  function warnMissing(key) {
    if (_warnedKeys[key]) return;
    _warnedKeys[key] = true;
    try {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn("[s1] narrate: no value for placeholder {" + key + "}; substituting \"\".");
      }
    } catch (e) { /* dev-time signal only */ }
  }

  function fill(template, vars) {
    return template.replace(/\{([a-zA-Z_]+)\}/g, function (m, k) {
      if (vars[k] !== undefined && vars[k] !== null) return String(vars[k]);
      warnMissing(k);
      return "";
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
        fr = fill("« {label} » ajouté comme {type_fr}.", { label: labelFr(ctx.label), type_fr: TYPE_FR[params.type] || params.type });
        break;
      case "add_collection_point":
        en = fill("Added {label} as a collection point.", { label: ctx.label });
        fr = fill("« {label} » ajouté comme point de collecte.", { label: labelFr(ctx.label) });
        break;
      case "connect":
        en = fill("Connected {a_label} to {b_label} ({cat}).", { a_label: ctx.a_label, b_label: ctx.b_label, cat: params.cat });
        fr = fill("« {a_label} » connecté à « {b_label} » ({cat_fr}).", { a_label: labelFr(ctx.a_label), b_label: labelFr(ctx.b_label), cat_fr: CAT_FR[params.cat] || params.cat });
        break;
      case "set_field":
        en = fill("Changed {field} on {label} to {value}.", { field: params.field, label: ctx.label, value: params.value });
        fr = fill("« {field_fr} » de « {label} » changé à « {value} ».", { field_fr: FIELD_FR[params.field] || params.field, label: labelFr(ctx.label), value: params.value });
        break;
      case "set_retention": {
        var label = ctx.label;
        if (params.verify_only === true) {
          en = fill("Flagged {record_type} on {label} for verification: no cited period.",
            { record_type: params.record_type, label: label });
          fr = fill("« {record_type} » sur « {label} » marqué à vérifier : aucune durée citée.",
            { record_type: recordTypeFr(params.record_type), label: labelFr(label) });
        } else {
          var anchorEn = params.anchor ? ", measured " + params.anchor + "," : "";
          var anchorFr = params.anchor ? ", à compter de " + params.anchor + "," : "";
          en = fill("Noted {min} to {max} years retention for {record_type} on {label}{anchor} per {statute}.",
            { min: params.range_min_years, max: params.range_max_years, record_type: params.record_type, label: label, anchor: anchorEn, statute: params.statute });
          fr = fill("Conservation de {min} à {max} ans notée pour « {record_type} » sur « {label} »{anchor} ({statute}).",
            { min: params.range_min_years, max: params.range_max_years, record_type: recordTypeFr(params.record_type), label: labelFr(label), anchor: anchorFr, statute: params.statute });
        }
        break;
      }
      case "confirm_node": {
        var noteEn = params.note ? " Note: " + params.note + "." : "";
        var noteFr = params.note ? " Note : " + params.note + "." : "";
        en = "You confirmed " + ctx.label + "." + noteEn;
        fr = "« " + labelFr(ctx.label) + " » confirmé." + noteFr;
        break;
      }
      case "flag_for_review":
        en = fill("Flagged {target} for review: {reason}.", { target: ctx.target, reason: params.reason });
        fr = fill("« {target} » signalé pour révision : {reason}.", { target: labelFr(ctx.target), reason: params.reason });
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
        /* The export step never downloads on its own: the file downloads
           only when the reader clicks the download button on the results
           screen. The narration says exactly that (2026-10-05: the old
           "Downloaded the Excel inventory." claimed a download that never
           happened). */
        en = "Export step complete. Download the Excel file from the results screen.";
        fr = "Étape d'exportation terminée. Téléchargez le fichier Excel depuis l'écran des résultats.";
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

  /* Review cards (replaces the old interrogation-pattern reviewPrompt,
   * removed 2026-10-05: "I put X here as Y. Right?" leaked raw
   * {placeholders} when its nested fill met an incomplete context).
   *
   * reviewCardText(kind, data, lang) is the assert-safe card renderer.
   * It builds every string by concatenation from resolved values, never
   * from a {placeholder} template, so an unfilled placeholder is
   * impossible by construction: every lookup has a hard fallback and a
   * missing label degrades to "Unnamed item", never to "{label}".
   *
   * kind: "node" | "edge" | "retention".
   * data: node -> {label, type}; edge -> {aLabel, bLabel, cat};
   *       retention -> {label, verify} or {label, min, max} (years).
   * Returns {groupKey, group, name, typeLine}, all plain strings. */

  var PLAIN_TYPE = {
    en: {
      collection: "Collection point", system: "System",
      thirdparty: "Third party", destruction: "Secure destruction"
    },
    fr: {
      collection: "Point de collecte", system: "Système",
      thirdparty: "Tiers", destruction: "Destruction sécurisée"
    }
  };
  var PLAIN_CAT = {
    en: { contact: "Contact / identity", payment: "Payment", marketing: "Marketing / consent" },
    fr: { contact: "Contact / identité", payment: "Paiement", marketing: "Marketing / consentement" }
  };
  var PLAIN_GROUP = {
    en: {
      collection: "Collection points", system: "Systems",
      thirdparty: "Third parties", destruction: "Secure destruction",
      flow: "Data flows", retention: "Retention notes"
    },
    fr: {
      collection: "Points de collecte", system: "Systèmes",
      thirdparty: "Tiers", destruction: "Destruction sécurisée",
      flow: "Flux de données", retention: "Notes de conservation"
    }
  };

  function reviewCardText(kind, data, lang) {
    var fr = lang === "fr";
    var L = fr ? "fr" : "en";
    data = data || {};
    function name(v) {
      if (v !== undefined && v !== null && String(v).length > 0) return String(v);
      return fr ? "Élément sans nom" : "Unnamed item";
    }
    if (kind === "edge") {
      var cat = PLAIN_CAT[L][data.cat];
      return {
        groupKey: "flow",
        group: PLAIN_GROUP[L].flow,
        name: name(data.aLabel) + " → " + name(data.bLabel),
        typeLine: (fr ? "Flux de données" : "Data flow") + (cat ? " · " + cat : "")
      };
    }
    if (kind === "retention") {
      var range = null;
      if (data.verify === true) {
        range = fr ? "à vérifier" : "to verify";
      } else if (data.min !== undefined && data.min !== null &&
                 data.max !== undefined && data.max !== null) {
        range = fr
          ? "de " + data.min + " à " + data.max + " ans"
          : data.min + " to " + data.max + " years";
      }
      return {
        groupKey: "retention",
        group: PLAIN_GROUP[L].retention,
        name: name(data.label),
        typeLine: (fr ? "Note de conservation" : "Retention note") +
          (range ? " · " + range : "")
      };
    }
    /* node (default): the group follows the node type. */
    var t = data.type;
    return {
      groupKey: ["collection", "system", "thirdparty", "destruction"].indexOf(t) !== -1 ? t : "node",
      group: PLAIN_GROUP[L][t] || (fr ? "Éléments" : "Items"),
      name: name(data.label),
      typeLine: PLAIN_TYPE[L][t] || (fr ? "Élément" : "Item")
    };
  }

  function articleEn(type) {
    return { collection: "a collection point", system: "a system", thirdparty: "a third party", destruction: "a destruction point" }[type] || type;
  }

  /* Correction confirmation (domain contract 5). */
  function correctionConfirm(kind, ctx, lang) {
    var fr = lang === "fr";
    if (kind === "retype") {
      return fr
        ? fill("Corrigé : « {label} » est maintenant {category_fr}.", { label: ctx.label, category_fr: ARTICLE_FR[ctx.type] })
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
    if (kind === "add_node") {
      return fr
        ? fill("« {label} » ajouté.", { label: ctx.label })
        : fill("Added {label}.", { label: ctx.label });
    }
    if (kind === "add_edge") {
      return fr
        ? fill("« {a_label} » connecté à « {b_label} ».", { a_label: ctx.a_label, b_label: ctx.b_label })
        : fill("Connected {a_label} to {b_label}.", { a_label: ctx.a_label, b_label: ctx.b_label });
    }
    if (kind === "set_meta") {
      return fr ? "Détails enregistrés." : "Details saved.";
    }
    if (kind === "remove_node" || kind === "remove_edge" || kind === "remove_retention") {
      return fr
        ? fill("« {label} » retiré.", { label: ctx.label })
        : fill("Removed {label}.", { label: ctx.label });
    }
    return fr ? "Corrigé." : "Fixed.";
  }

  return {
    narrate: narrate,
    reviewCardText: reviewCardText,
    correctionConfirm: correctionConfirm,
    labelFr: labelFr,
    recordTypeFr: recordTypeFr,
    LABEL_FR: LABEL_FR,
    RECORD_TYPE_FR: RECORD_TYPE_FR,
    TYPE_FR: TYPE_FR,
    CAT_FR: CAT_FR,
    PLAIN_TYPE: PLAIN_TYPE,
    PLAIN_CAT: PLAIN_CAT
  };
});
