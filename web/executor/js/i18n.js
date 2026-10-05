/**
 * i18n.js - UI chrome strings for the assistant (EN + Quebec French).
 *
 * Narration templates live in narrate.js (from the domain contract).
 * This file covers chips, buttons, the trust counter, and flow chrome.
 * Quebec French register follows the contract's FR templates.
 *
 * UMD: runs in browsers and Node. No em dashes.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module !== null && typeof module.exports === "object") {
    module.exports = api;
  } else {
    root.S1I18n = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var STRINGS = {
    en: {
      entryTitle: "Map my data with the assistant",
      entryBody: "Four taps, no typing. The assistant builds your data map step by step, right in your browser, and you review each piece.",
      entryButton: "Start",
      chipSize: "Company size",
      chipSector: "Sector",
      chipRegion: "Where the data lives",
      chipTypes: "Main data types",
      sectorNames: {
        retail: "Retail", services: "Services", health: "Health and care",
        tech: "Technology and SaaS", manufacturing: "Manufacturing", nonprofit: "Nonprofit"
      },
      regionNames: {
        quebec: "Quebec only", canada: "Canada-wide",
        "canada-us": "Canada and the US", international: "International"
      },
      typesNames: {
        contact: "Contact info only", "contact-payment": "Contact plus payments",
        "contact-marketing": "Contact plus marketing", all: "Contact, payments, and marketing"
      },
      templateMissing: "That combination is not authored yet. Try one of the ready templates below.",
      readyTemplates: "Ready templates",
      startRun: "Build my map",
      back: "Back",
      loadingModel: "Loading the assistant model...",
      modelReady: "Model ready. Building your map.",
      stepLogTitle: "Steps",
      stop: "Stop",
      stopped: "Stopped. Nothing was sent anywhere.",
      runComplete: "Map built. Now review each piece.",
      flagPaused: "The assistant flagged something for review. Clear the flag to continue.",
      clearFlag: "Clear flag and continue",
      reviewTitle: "Review",
      reviewLede: "One tap per row. Confirm what is right, fix what is not.",
      confirm: "Confirm",
      fix: "Fix",
      fixRelabel: "Rename",
      fixRetype: "Change type",
      fixMove: "Move",
      fixReconnect: "Reconnect",
      fixVerify: "Mark verify-only",
      fixRemove: "Remove",
      fixLabelPrompt: "New label",
      fixApply: "Apply fix",
      fixCancel: "Cancel",
      newLabel: "New label",
      chooseType: "Choose the type",
      newTarget: "New target",
      chooseCategory: "Category",
      confirmed: "confirmed",
      unconfirmed: "unconfirmed",
      reviewDone: "Review complete.",
      downloadExcel: "Download draft Excel",
      downloadCorrections: "Download correction log",
      wipe: "Wipe everything",
      wipeDone: "Wiped. Nothing persists.",
      wipeConfirm: "Wipe everything? The map, the log, and the review are cleared and nothing is kept.",
      requestsSent: "requests sent",
      trustCopy: "Everything runs in your browser. Nothing is sent anywhere.",
      draftBadge: "Draft for review",
      assistantThinking: "Assistant is working...",
      correctionsNone: "No corrections logged.",
      sessionLabel: "Session",
      close: "Close"
    },
    fr: {
      entryTitle: "Cartographiez mes données avec l’assistant",
      entryBody: "Quatre choix, sans rien taper. L’assistant construit votre carte de données étape par étape, dans votre navigateur, et vous révisez chaque élément.",
      entryButton: "Commencer",
      chipSize: "Taille de l’entreprise",
      chipSector: "Secteur",
      chipRegion: "Où se trouvent les données",
      chipTypes: "Principaux types de données",
      sectorNames: {
        retail: "Commerce de détail", services: "Services", health: "Santé",
        tech: "Technologie", manufacturing: "Fabrication", nonprofit: "OBNL"
      },
      regionNames: {
        quebec: "Québec seulement", canada: "Partout au Canada",
        "canada-us": "Canada et États-Unis", international: "International"
      },
      typesNames: {
        contact: "Coordonnées seulement", "contact-payment": "Coordonnées et paiements",
        "contact-marketing": "Coordonnées et marketing", all: "Coordonnées, paiements et marketing"
      },
      templateMissing: "Cette combinaison n’est pas encore prête. Essayez un des modèles ci-dessous.",
      readyTemplates: "Modèles prêts",
      startRun: "Construire ma carte",
      back: "Retour",
      loadingModel: "Chargement du modèle d’assistant...",
      modelReady: "Modèle prêt. Construction de votre carte.",
      stepLogTitle: "Étapes",
      stop: "Arrêter",
      stopped: "Arrêté. Rien n’a été envoyé nulle part.",
      runComplete: "Carte construite. Révisez maintenant chaque élément.",
      flagPaused: "L’assistant a signalé un point à réviser. Effacez le signalement pour continuer.",
      clearFlag: "Effacer et continuer",
      reviewTitle: "Révision",
      reviewLede: "Un choix par ligne. Confirmez ce qui est bon, corrigez le reste.",
      confirm: "Confirmer",
      fix: "Corriger",
      fixRelabel: "Renommer",
      fixRetype: "Changer le type",
      fixMove: "Déplacer",
      fixReconnect: "Reconnecter",
      fixVerify: "Marquer à vérifier",
      fixRemove: "Retirer",
      fixLabelPrompt: "Nouveau nom",
      fixApply: "Appliquer",
      fixCancel: "Annuler",
      newLabel: "Nouveau nom",
      chooseType: "Choisissez le type",
      newTarget: "Nouvelle cible",
      chooseCategory: "Catégorie",
      confirmed: "confirmé",
      unconfirmed: "non confirmé",
      reviewDone: "Révision terminée.",
      downloadExcel: "Télécharger le chiffrier brouillon",
      downloadCorrections: "Télécharger le journal de corrections",
      wipe: "Tout effacer",
      wipeDone: "Effacé. Rien n’est conservé.",
      wipeConfirm: "Tout effacer? La carte, le journal et la révision sont effacés, rien n’est conservé.",
      requestsSent: "requêtes envoyées",
      trustCopy: "Tout se passe dans votre navigateur. Rien n’est envoyé nulle part.",
      draftBadge: "Brouillon à réviser",
      assistantThinking: "L’assistant travaille...",
      correctionsNone: "Aucune correction consignée.",
      sessionLabel: "Session",
      close: "Fermer"
    }
  };

  function strings(lang) {
    return STRINGS[lang === "fr" ? "fr" : "en"];
  }

  return { strings: strings, STRINGS: STRINGS };
});
