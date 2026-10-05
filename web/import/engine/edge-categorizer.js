/**
 * edge-categorizer.js
 *
 * The template's "Data categories transferred" column is free text and carries no
 * edge-category column (freeze mismatch #5). The guide needs one of the three
 * fixed edge categories per edge: contact, payment, marketing.
 *
 * This module proposes a category from keyword rules. Every proposal is marked
 * explicitly inferred: true. The UI shows proposals as suggestions for visitor
 * confirmation. Nothing is ever applied silently.
 *
 * Pure logic: no DOM, no network.
 */

const PAYMENT_KEYWORDS = [
  "payment", "billing", "card", "credit card", "invoice", "refund",
  "charge", "transaction", "paiement", "facturation", "carte",
];

const MARKETING_KEYWORDS = [
  "marketing", "consent", "newsletter", "email campaign", "email marketing",
  "subscription", "consentement", "infolettre", "abonnement",
];

function proposeCategory(freeText) {
  const text = String(freeText == null ? "" : freeText).toLowerCase();

  for (const kw of PAYMENT_KEYWORDS) {
    if (text.includes(kw)) {
      return {
        cat: "payment",
        reason: `Matched the payment keyword '${kw}' in '${String(freeText).trim()}'.`,
        inferred: true,
      };
    }
  }
  for (const kw of MARKETING_KEYWORDS) {
    if (text.includes(kw)) {
      return {
        cat: "marketing",
        reason: `Matched the marketing keyword '${kw}' in '${String(freeText).trim()}'.`,
        inferred: true,
      };
    }
  }
  return {
    cat: "contact",
    reason: "No payment or marketing keywords found; contact/identity is the default category.",
    inferred: true,
  };
}

module.exports = { proposeCategory };
