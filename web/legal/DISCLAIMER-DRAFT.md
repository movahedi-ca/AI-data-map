DRAFT PENDING COUNSEL REVIEW - do not publish without counsel sign-off.

# Disclaimer and liability copy (draft for counsel review)

Status: DRAFT. Not approved for publication, for the tool page, or for the exported Excel file. See the sign-off block at the end.

This document holds the exact words that ship with the data mapping assistant on movahedi.ca and inside its exported Excel inventory. Nothing here is a legal conclusion. Counsel must review and sign off before launch.

## 1. The claim rules (from playbook Section 9)

Every output of the tool is a draft inventory. Never "finished", never "lawyer-ready", never "compliant".

1. Every output is a draft for review, not legal advice. The framing sits on the tool page, in the tool UI, and inside the exported Excel file.
2. Law 25 is framed as: "an inventory to support Law 25 governance and retention-schedule obligations." Never say or imply that Law 25 requires a "data inventory" by name. It does not.
3. Retention entries are ranges, never single numbers. Each range cites the statute and section that sets the period, with an as-of date. Anything that cannot cite a statute ships with a "verify" flag and no range.
4. Privacy claims are qualified to match the network-tab audit. The unqualified line "nothing leaves your browser" is reserved for the offline air-gapped bundle only. The live tool page states the audited claim and sits next to the live "0 requests sent" counter.
5. The tool does not call its output defensible, compliant, or lawyer-ready. No exceptions.

## 2. Tool page copy (draft, EN)

Place this directly under the assistant's start screen, visible before the first tap:

> Draft for review, not legal advice.
>
> This assistant builds a draft data inventory to support your Law 25 governance and retention-schedule obligations. Law 25 does not require a "data inventory" by name; this tool gives you a starting inventory that your lawyer reviews and your team completes.
>
> Every output is a draft. Retention periods are shown as ranges with the statute cited and an as-of date. Entries the tool cannot verify are flagged "verify" instead of given a number. Nothing the tool produces is lawyer-ready or a statement that you are compliant.
>
> Privacy: this page loads no third-party scripts. The tool watches its own network activity and shows the count on screen. The "0 requests sent" counter next to this notice reflects the pre-launch audit of this page build. A full audit procedure is documented in the pre-launch DPIA. The strongest form of this guarantee is the offline bundle: download it, disconnect, and the full flow still works with the wifi off. Only the offline bundle carries the unqualified claim that nothing leaves your machine.

Place the "0 requests sent" counter immediately beside the privacy paragraph, not below the fold.

French (draft):

> Brouillon à réviser, pas un avis juridique.
>
> Cet assistant produit un inventaire provisoire pour appuyer vos obligations de gouvernance et de calendrier de conservation en lien avec la Loi 25. La Loi 25 n'exige pas nommément un « inventaire des données »; cet outil vous fournit un point de départ que votre avocate ou avocat révise et que votre équipe complète.
>
> Chaque résultat est un brouillon. Les délais de conservation sont indiqués sous forme de plages, avec la loi citée et une date de vérification. Les éléments non vérifiables sont marqués « à vérifier » plutôt que chiffrés. Rien de ce que produit l'outil n'est prêt pour un avocat ni une déclaration de conformité.
>
> Vie privée : cette page ne charge aucun script tiers. L'outil surveille sa propre activité réseau et affiche le compteur à l'écran. Le compteur « 0 requête envoyée » à côté de cet avis reflète l'audit de pré-lancement de cette version de la page. La procédure d'audit complète est documentée dans l'EFVP de pré-lancement. La forme la plus forte de cette garantie est le forfait hors ligne : téléchargez-le, déconnectez-vous, et le flux complet fonctionne avec le wifi éteint. Seul le forfait hors ligne porte la garantie sans réserve que rien ne quitte votre machine.

## 3. Exported Excel file copy (draft, EN + FR)

The exported .xls file carries the draft label in the file itself, matching the banner already implemented in the exporter code (web/executor/js/exporter.js, draftBanner): EN "DRAFT FOR REVIEW. Verify every row before use. Not legal advice." / FR "BROUILLON À RÉVISER. Vérifiez chaque ligne avant usage. Pas un avis juridique."

The file also carries a cover sheet with this copy:

> DRAFT FOR REVIEW - verify every row before use. Not legal advice.
>
> This file is a draft data inventory to support Law 25 governance and retention-schedule obligations. It is not lawyer-ready, and it is not a statement that your organization is compliant.
>
> Retention columns show ranges with the cited statute and an as-of date, per the retention rule in the tool's documentation. Rows flagged "verify" need human review before they can be relied on.
>
> Review checklist included: confirm or fix every auto-placed node, check each "verify" flag, have counsel review before relying on this file.

French cover sheet:

> BROUILLON À RÉVISER - vérifiez chaque ligne avant usage. Pas un avis juridique.
>
> Ce fichier est un inventaire provisoire pour appuyer vos obligations de gouvernance et de calendrier de conservation en lien avec la Loi 25. Il n'est pas prêt pour un avocat et ne constitue pas une déclaration de conformité de votre organisation.
>
> Les colonnes de conservation indiquent des plages avec la loi citée et une date de vérification, selon la règle de conservation documentée de l'outil. Les lignes marquées « à vérifier » exigent une révision humaine avant toute utilisation.
>
> Liste de révision incluse : confirmez ou corrigez chaque élément placé automatiquement, vérifiez chaque marque « à vérifier », faites réviser par un avocat avant de vous fier à ce fichier.

## 4. Placement checklist (for the deploy step)

- Tool page: Section 2 copy under the start screen, privacy paragraph beside the live "0 requests sent" counter.
- Tool UI: the "Draft for review" badge stays visible through review and download steps.
- Excel export: banner row in every export plus the cover sheet copy in Section 3.
- Offline bundle: the bundle page carries the same copy, plus the single unqualified claim: "Nothing leaves your machine. Run it with the wifi off."
- Model card and data card: Section 11 publication-gate lines must appear on both cards: draft aid, not legal advice; trained on synthetic data; retention entries are ranges with statute citations and as-of dates; verify before use.

## 5. Phrases that never ship

- lawyer-ready
- compliant / in compliance
- finished inventory / complete inventory (without "draft")
- "Law 25 requires a data inventory"
- a bare retention number with no statute citation and no as-of date
- "nothing leaves your browser" on the live tool page (reserved for the offline bundle)

## Sign-off

| Field | Value |
|---|---|
| Reviewer name | |
| Review date | |
| Decision | APPROVED / APPROVED WITH CHANGES / REJECTED |
| Changes required | |
| Signature | |

No launch without a completed sign-off block above. If the decision is APPROVED WITH CHANGES, the changes must be applied and the document re-signed before any copy ships.
