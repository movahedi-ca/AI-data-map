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
      /* Single-panel chrome (Issue 8): one title + one lede for the merged
         assistant; the mode toggle picks the quick 4-tap intake or the
         guided chat. The old entryTitle/chatTitle keys stay for
         compatibility but are no longer rendered. */
      assistantTitle: "AI Data Mapping Assistant",
      assistantLede: "Two ways to start. Pick four quick answers, or walk through it in a chat. Either way, the assistant drafts your data map in your browser, and you review every piece before anything is exported.",
      modeLabel: "How to start",
      modeQuick: "Quick setup",
      modeQuickDesc: "Four taps, no typing.",
      modeGuided: "Guided chat",
      modeGuidedDesc: "Four questions in a chat, or paste a recipe.",
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
      engineFailed: "The assistant couldn't start in this browser. Start over or try the Excel template path.",
      stepFailed: "Something went wrong while building the map. Start over or try the Excel template path.",
      stepLogTitle: "Steps",
      stop: "Stop",
      startOver: "Start over",
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
      close: "Close",
      chatTitle: "Chat with the mapping assistant",
      chatLede: "Answer four quick questions and the assistant drafts your data map, step by step, in your browser.",
      chatGreeting: "Hello. I will help you sketch a first draft of your data map. Everything this page produces is a draft for review, not legal advice. Nothing leaves your browser.",
      chatAskSize: "First: how many people work at the company?",
      chatAskSector: "Which sector describes it best?",
      chatAskRegion: "Where does the data live?",
      chatAskTypes: "Last one: what kinds of personal data are we mapping?",
      chatOrPaste: "Or paste a recipe JSON",
      chatPasteIntro: "Paste a recipe JSON below. It is checked against the recipe schema before anything runs.",
      chatPastePlaceholder: '{"recipe_id": "my-recipe-01", "schema_version": "1.0.0", "items": [...]}',
      chatPasteUse: "Check and use this recipe",
      chatPastedRecipe: "Pasted recipe {id}.",
      chatRecipeValid: "Recipe checked: {name} ({n} steps).",
      chatTemplateMatched: "Got it: {name}. That's a {n}-step build.",
      chatTemplateNodes: "It maps: {labels}.",
      chatTicket: "Session {id} opened for recipe {recipe}. {n} steps to run.",
      chatStepPrefix: "Step {n}:",
      chatBusy: "A mapping session is already running on this page. Finish it or wipe everything first.",
      chatStartOver: "Start over",
      chatHandoffTitle: "The map is built. Now review each piece.",
      chatHandoffBody: "The next screen walks you through the map, piece by piece. Confirm what is right, fix what is not, then download the draft Excel file.",
      chatHandoffButton: "Continue to review",
      chatErrBadChips: "Something went wrong reading your answers. Let us start over.",
      chatErrNotJson: "That is not valid JSON: {detail}",
      chatErrNotObject: "The recipe must be a JSON object, not a list or a bare value.",
      chatErrBadRecipeId: "The recipe needs a recipe_id made of letters, numbers, dashes, or underscores.",
      chatErrBadSchema: "The recipe declares schema_version {got}; this assistant only runs 1.0.x recipes.",
      chatErrNoItems: "The recipe needs a non-empty items list.",
      chatErrItemNotObject: "Step {index} must be an object with an intent and params.",
      chatErrUnknownIntent: "Step {index} uses an unknown intent, \"{intent}\".",
      chatErrRecoveryIntent: "Step {index} uses \"{intent}\", which is executor-only; a recipe cannot include it.",
      chatErrParamsNotObject: "The params of step {index} must be an object.",
      chatErrMissingParam: "Step {index} ({intent}) needs the parameter \"{param}\".",
      chatErrRetentionRange: "Step {index} (set_retention) needs a retention range with a cited statute, or verify_only set to true."
    },
    fr: {
      entryTitle: "Cartographiez mes données avec l’assistant",
      entryBody: "Quatre choix, sans rien taper. L’assistant construit votre carte de données étape par étape, dans votre navigateur, et vous révisez chaque élément.",
      /* Single-panel chrome (Issue 8): see the EN block above. */
      assistantTitle: "Assistant IA de cartographie des données",
      assistantLede: "Deux façons de commencer. Choisissez quatre réponses rapides ou avancez en conversation. Dans les deux cas, l’assistant esquisse votre carte de données dans votre navigateur, et vous révisez chaque élément avant toute exportation.",
      modeLabel: "Comment commencer",
      modeQuick: "Configuration rapide",
      modeQuickDesc: "Quatre choix, sans rien taper.",
      modeGuided: "Conversation guidée",
      modeGuidedDesc: "Quatre questions en conversation, ou collez une recette.",
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
      engineFailed: "L’assistant n’a pas pu démarrer dans ce navigateur. Recommencez ou essayez le modèle Excel.",
      stepFailed: "Un problème est survenu pendant la construction de la carte. Recommencez ou essayez le modèle Excel.",
      stepLogTitle: "Étapes",
      stop: "Arrêter",
      startOver: "Recommencer",
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
      close: "Fermer",
      chatTitle: "Discutez avec l’assistant de cartographie",
      chatLede: "Répondez à quatre questions rapides et l’assistant esquisse votre carte de données, étape par étape, dans votre navigateur.",
      chatGreeting: "Bonjour. Je vais vous aider à esquisser un premier brouillon de votre carte de données. Tout ce que cette page produit est un brouillon à réviser, pas un avis juridique. Rien ne quitte votre navigateur.",
      chatAskSize: "D’abord : combien de personnes travaillent dans l’entreprise?",
      chatAskSector: "Quel secteur la décrit le mieux?",
      chatAskRegion: "Où se trouvent les données?",
      chatAskTypes: "Dernière question : quels types de données personnelles cartographions-nous?",
      chatOrPaste: "Ou collez un JSON de recette",
      chatPasteIntro: "Collez ci-dessous un JSON de recette. Il est vérifié selon le schéma de recette avant que quoi que ce soit ne s’exécute.",
      chatPastePlaceholder: '{"recipe_id": "ma-recette-01", "schema_version": "1.0.0", "items": [...]}',
      chatPasteUse: "Vérifier et utiliser cette recette",
      chatPastedRecipe: "Recette collée : {id}.",
      chatRecipeValid: "Recette vérifiée : {name} ({n} étapes).",
      chatTemplateMatched: "Compris : {name}. Ça fait une construction de {n} étapes.",
      chatTemplateNodes: "Éléments cartographiés : {labels}.",
      chatTicket: "Session {id} ouverte pour la recette {recipe}. {n} étapes à exécuter.",
      chatStepPrefix: "Étape {n} :",
      chatBusy: "Une session de cartographie est déjà en cours sur cette page. Terminez-la ou effacez tout d’abord.",
      chatStartOver: "Recommencer",
      chatHandoffTitle: "La carte est construite. Révisez maintenant chaque élément.",
      chatHandoffBody: "L’écran suivant vous guide dans la carte, élément par élément. Confirmez ce qui est bon, corrigez le reste, puis téléchargez le chiffrier brouillon.",
      chatHandoffButton: "Passer à la révision",
      chatErrBadChips: "Un problème est survenu en lisant vos réponses. Recommençons.",
      chatErrNotJson: "Ce n’est pas du JSON valide : {detail}",
      chatErrNotObject: "La recette doit être un objet JSON, pas une liste ni une valeur seule.",
      chatErrBadRecipeId: "La recette a besoin d’un recipe_id fait de lettres, de chiffres, de traits d’union ou de soulignés.",
      chatErrBadSchema: "La recette indique schema_version « {got} »; cet assistant n’exécute que les recettes 1.0.x.",
      chatErrNoItems: "La recette a besoin d’une liste d’étapes (items) non vide.",
      chatErrItemNotObject: "L’étape {index} doit être un objet avec un intent et des params.",
      chatErrUnknownIntent: "L’étape {index} utilise un intent inconnu, « {intent} ».",
      chatErrRecoveryIntent: "L’étape {index} utilise « {intent} », réservé à l’exécuteur; une recette ne peut pas l’inclure.",
      chatErrParamsNotObject: "Les params de l’étape {index} doivent être un objet.",
      chatErrMissingParam: "L’étape {index} ({intent}) a besoin du paramètre « {param} ».",
      chatErrRetentionRange: "L’étape {index} (set_retention) a besoin d’une plage de conservation avec un texte de loi cité, ou de verify_only à vrai."
    }
  };

  function strings(lang) {
    return STRINGS[lang === "fr" ? "fr" : "en"];
  }

  return { strings: strings, STRINGS: STRINGS };
});
