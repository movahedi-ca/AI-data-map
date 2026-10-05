/**
 * exporter.js - draft Excel export for the assistant flow.
 *
 * Extends the Phase 1 SpreadsheetML exporter (window.DMEngine.
 * buildSpreadsheetML, which writes the Nodes/Noeuds and Connections/Liens
 * sheets) with two more sheets:
 *   - "Review" / "Révision": the review checklist (one row per artifact).
 *   - "Confirmations": the confirmation record (domain contract 6.2).
 * Every sheet carries draft-for-review labeling. The result re-imports
 * through the Phase 1 importer (extra sheets are ignored by
 * findInventorySheets; node/edge sheets keep their Phase 1 shape).
 *
 * Depends on s1util.js and window.DMEngine (engine-bundle.js). When
 * DMEngine is absent, falls back to a local minimal builder with the same
 * sheet shapes for the inventory sheets.
 * UMD: browsers and Node. No em dashes.
 */
(function (root, factory) {
  "use strict";
  var api = factory(root.S1Util);
  if (typeof module === "object" && module !== null && typeof module.exports === "object") {
    module.exports = api;
  } else {
    root.S1Exporter = api;
  }
})(typeof self !== "undefined" ? self : this, function (U) {
  "use strict";

  if (!U) throw new Error("exporter.js requires s1util.js (S1Util) to load first.");

  var TYPE_DISPLAY = {
    en: { collection: "Collection point", system: "System", thirdparty: "Third party", destruction: "Secure destruction" },
    fr: { collection: "Point de collecte", system: "Système", thirdparty: "Tiers", destruction: "Destruction sécurisée" }
  };
  var CAT_DISPLAY = {
    en: { contact: "Contact / identity", payment: "Payment", marketing: "Marketing / consent" },
    fr: { contact: "Contact / identité", payment: "Paiement", marketing: "Marketing / consentement" }
  };

  function escapeXml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function cell(v) {
    return "<Cell><Data ss:Type=\"String\">" + escapeXml(v) + "</Data></Cell>";
  }

  function row(cells) {
    return "<Row>" + cells.map(cell).join("") + "</Row>";
  }

  function sheet(name, rows) {
    return "<Worksheet ss:Name=\"" + escapeXml(name) + "\"><Table>" + rows.join("") + "</Table></Worksheet>";
  }

  function draftBanner(lang) {
    return lang === "fr"
      ? "BROUILLON À RÉVISER. Vérifiez chaque ligne avant usage. Pas un avis juridique."
      : "DRAFT FOR REVIEW. Verify every row before use. Not legal advice.";
  }

  function statusLabel(status, lang) {
    if (status === "confirmed") return lang === "fr" ? "confirmé" : "confirmed";
    return lang === "fr" ? "non confirmé" : "unconfirmed";
  }

  function kindLabel(kind, lang) {
    if (kind === "node") return lang === "fr" ? "nœud" : "node";
    if (kind === "edge") return lang === "fr" ? "lien" : "edge";
    return lang === "fr" ? "conservation" : "retention";
  }

  function detailText(r, lang) {
    if (r.removed) return lang === "fr" ? "supprimé pendant la révision" : "removed during review";
    if (r.kind === "node") {
      var tn = (TYPE_DISPLAY[lang] || TYPE_DISPLAY.en)[r.detail.type] || r.detail.type;
      return tn + " (" + r.detail.x + ", " + r.detail.y + ")";
    }
    if (r.kind === "edge") {
      return (CAT_DISPLAY[lang] || CAT_DISPLAY.en)[r.detail.cat] || r.detail.cat;
    }
    var d = r.detail;
    var range = d.range === "verify"
      ? (lang === "fr" ? "à vérifier" : "verify")
      : d.range;
    return d.record_type + ": " + range + (d.statute ? " (" + d.statute + ")" : "");
  }

  function reviewSheet(checklist, lang) {
    var name = lang === "fr" ? "Révision" : "Review";
    var head = lang === "fr"
      ? ["Réf", "Élément", "Détail", "Statut"]
      : ["Ref", "Artifact", "Detail", "Status"];
    var rows = [row([draftBanner(lang)]), row([""]), row(head)];
    checklist.forEach(function (r) {
      rows.push(row([r.ref, kindLabel(r.kind, lang) + ": " + r.label, detailText(r, lang), statusLabel(r.status, lang)]));
    });
    return sheet(name, rows);
  }

  function confirmationsSheet(confirmations, lang) {
    var head = lang === "fr"
      ? ["Session", "Recette", "Étape", "Réf", "Élément", "Note", "Par", "Le"]
      : ["Session", "Recipe", "Item", "Ref", "Artifact", "Note", "By", "At"];
    var rows = [row([draftBanner(lang)]), row([""]), row(head)];
    confirmations.forEach(function (c) {
      rows.push(row([c.session_id, c.recipe_id, String(c.item_index), c.ref, c.label, c.note, c.by, c.at]));
    });
    return sheet("Confirmations", rows);
  }

  /**
   * Build the full draft workbook XML.
   * @param {object} state {nodes, edges} frozen guide state.
   * @param {Array} checklist rows from S1Review.deriveChecklist.
   * @param {Array} confirmations confirmation records.
   * @param {"en"|"fr"} lang.
   * @returns {string} SpreadsheetML 2003 XML with BOM.
   */
  function buildDraftWorkbook(state, checklist, confirmations, lang) {
    var l = lang === "fr" ? "fr" : "en";
    var base;
    var DMEngine = (typeof window !== "undefined" && window.DMEngine) ||
      (typeof self !== "undefined" && self.DMEngine);
    if (DMEngine && typeof DMEngine.buildSpreadsheetML === "function") {
      base = DMEngine.buildSpreadsheetML(state, l);
    } else {
      base = minimalInventory(state, l);
    }
    var text = base.replace(/^﻿/, "");
    var extra = reviewSheet(checklist, l) + confirmationsSheet(confirmations, l);
    text = text.replace(/<\/Workbook>\s*$/, extra + "</Workbook>");
    return "﻿" + text;
  }

  /* Fallback inventory builder with the Phase 1 sheet shapes, used only
     when DMEngine is not on the page (e.g. Node tests). */
  function minimalInventory(state, lang) {
    var l = lang === "fr" ? "fr" : "en";
    var typeName = TYPE_DISPLAY[l], catName = CAT_DISPLAY[l];
    var nodesSheet = l === "fr" ? "Nœuds" : "Nodes";
    var linksSheet = l === "fr" ? "Liens" : "Connections";
    var disclaimer = draftBanner(l);
    var ids = Object.keys(state.nodes).sort(function (a, b) { return U.nodeNum(a) - U.nodeNum(b); });
    var labelOf = function (id) { return (state.nodes[id] && state.nodes[id].label) || ""; };
    var nodeRows = [
      row([disclaimer]),
      row([""]),
      row([l === "fr" ? "Étiquette" : "Label", "Type"])
    ].concat(ids.map(function (id) {
      var n = state.nodes[id];
      return row([n.label, typeName[n.type] || n.type]);
    }));
    var edgeRows = [
      row([l === "fr" ? "De" : "From", l === "fr" ? "Vers" : "To", l === "fr" ? "Catégorie" : "Category"])
    ].concat((state.edges || []).map(function (e) {
      return row([labelOf(e.a), labelOf(e.b), catName[e.cat] || e.cat]);
    }));
    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
      "<Workbook xmlns=\"urn:schemas-microsoft-com:office:spreadsheet\" " +
      "xmlns:ss=\"urn:schemas-microsoft-com:office:spreadsheet\">" +
      sheet(nodesSheet, nodeRows) + sheet(linksSheet, edgeRows) + "</Workbook>";
  }

  function toBytes(xml) {
    var enc = (typeof TextEncoder !== "undefined") ? new TextEncoder() : null;
    if (enc) return enc.encode(xml);
    var bytes = [];
    for (var i = 0; i < xml.length; i++) {
      var cp = xml.codePointAt(i);
      if (cp > 0xffff) i++;
      if (cp < 0x80) bytes.push(cp);
      else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
    return new Uint8Array(bytes);
  }

  return {
    buildDraftWorkbook: buildDraftWorkbook,
    draftBanner: draftBanner
  };
});
