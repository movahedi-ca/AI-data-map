# Retention rule (Phase 0 statute research)

## The hard rule

Retention values in the retention rule spec, in the Law 25 data inventory output, and in every vendor KB entry that implies a retention period are **ranges only, never single numbers**. Every entry cites the actual statute that sets the period, with the section, plus an as-of date. Done-heads emit **"verify"** flags, never compliance verdicts. If an entry cannot cite a statute, it ships with a "verify" flag and no range.

Why ranges: each statutory period below is a floor. Overlapping obligations, objection and appeal extensions, and ministerial demands can lengthen the real window, so a bare number misleads. The convention used here: take the statutory floor and state the range as the floor plus one year (for example, a 6-year floor becomes "6 to 7 years"). The floor itself is quoted from the statute in the same row so the anchor is always visible.

## Verified retention bases

All periods verified 2026-10-04. Ranges follow the convention above; the statutory floor is quoted verbatim from the source in each row.

| Record type | Range | Statutory floor (verbatim source) | Statute + section | As-of date |
|---|---|---|---|---|
| Federal tax books and records | 6 to 7 years from the end of the last taxation year to which the records relate | "until the expiration of six years from the end of the last taxation year to which the records and books of account relate" | Income Tax Act, R.S.C. 1985, c. 1 (5th Supp.), s. 230(4)(b) | 2026-10-04 |
| Federal tax: permanent corporate records (minutes, share registers, general ledger, special contracts) | 2 to 3 years after the date of dissolution | "la période se terminant deux ans après la date de la dissolution de la société" | Income Tax Regulations, C.R.C., c. 945, s. 5800(1)(a), made under ITA s. 230(4)(a) | 2026-10-04 |
| Federal tax: general ledger of a non-corporate business | 6 to 7 years after the last day of the person's taxation year in which the business ceased | "la période se terminant six ans après le dernier jour de l'année d'imposition de la personne où l'entreprise a cessé d'exister" | Income Tax Regulations, C.R.C., c. 945, s. 5800(1)(c), made under ITA s. 230(4)(a) | 2026-10-04 |
| Quebec tax books and records | 6 to 7 years from the end of the last year to which the records relate | "doivent être conservés pendant six ans après la dernière année à laquelle ils se rapportent" | Loi sur l'administration fiscale, RLRQ, c. A-6.002, ss. 34, 35.3; Revenu Québec guidance FP-500 | 2026-10-04 |
| Quebec payroll register (labour standards) | 3 to 4 years | "Le système d'enregistrement ou le registre se rapportant à une année doit être conservé durant une période de 3 ans." | Règlement sur le système d'enregistrement ou sur la tenue d'un registre, R.R.Q., c. N-1.1, r. 6, s. 2 (regulation under the Loi sur les normes du travail, RLRQ, c. N-1.1) | 2026-10-04 |
| Federal employment insurance payroll records | 6 to 7 years after the year for which they are kept | "The employer shall retain the records and books of account ... for six years after the year for which they are kept" | Employment Insurance Act, S.C. 1996, c. 23, s. 87(3) | 2026-10-04 |
| Federal Canada Pension Plan payroll records | 6 to 7 years from the end of the year to which they relate | "shall retain those records and books of account ... until the expiration of six years from the end of the year in respect of which those records and books of account are kept" | Canada Pension Plan Act, R.S.C. 1985, c. C-8, s. 24(2) | 2026-10-04 |
| AML client identification and information records (financial sector) | 5 to 6 years after the day on which the last business transaction is conducted (account-related records: after the account is closed) | "shall keep those records for a period of at least five years after ... the day on which the last business transaction is conducted" | Proceeds of Crime (Money Laundering) and Terrorist Financing Regulations, SOR/2002-184, s. 148(1)(a)-(b) | 2026-10-04 |
| Quebec health: main user dossier, public establishments (rule 10-010) | Duration of services for the dossier as a whole; 5 to 6 years for individual pieces, with exceptions listed in Annex A | "Conserver le dossier tant que l'usager reçoit des services de l'établissement. Dans ce dossier, des pièces peuvent être détruites après 5 ans, à l'exception des pièces énumérées à l'annexe A" | Loi sur les archives, RLRQ, c. A-21.1, s. 7 (retention schedule obligation); contents rules: Loi sur les services de santé et les services sociaux, RLRQ, c. S-4.2; Règlement sur l'organisation et l'administration des établissements, RLRQ, c. S-5, r. 5, ss. 52.1-56, 64; model rule: BAnQ Recueil des règles de conservation des documents des établissements de santé et de services sociaux, CNASSS, version 2024, rule 10-010 | 2026-10-04 |
| Quebec health: imaging records (rule 10-101) | 5 to 6 years after creation of the piece; interventional radiology reports 5 to 6 years after the user's death | "Conserver pendant 5 ans après la création de la pièce, sauf les rapports de radiologie interventionnelle qui sont conservés 5 ans après le décès de l'usager" | Loi sur les archives, RLRQ, c. A-21.1, s. 7 (retention schedule obligation); contents rules: Loi sur les services de santé et les services sociaux, RLRQ, c. S-4.2; Règlement sur l'organisation et l'administration des établissements, RLRQ, c. S-5, r. 5, ss. 52.1-56, 64; model rule: BAnQ Recueil des règles de conservation des documents des établissements de santé et de services sociaux, CNASSS, version 2024, rule 10-101 | 2026-10-04 |
| Quebec health: lab slides and blocks, anatomopathology (rule 10-102) | 10 to 11 years | Rule sets actif at 10 years | Loi sur les archives, RLRQ, c. A-21.1, s. 7 (retention schedule obligation); contents rules: Loi sur les services de santé et les services sociaux, RLRQ, c. S-4.2; Règlement d'application de la Loi sur les laboratoires médicaux, RLRQ, c. L-0.2, r. 1, s. 138(b); model rule: BAnQ Recueil 2024, rule 10-102 | 2026-10-04 |
| Quebec health: vaccination records (rule 10-106) | 5 to 6 years after the user's death, or 100 years after creation of the documents, whichever is shorter | "Conserver pendant 5 ans après le décès de l'usager ou 100 ans après la création des documents selon la durée la plus courte" | Loi sur les archives, RLRQ, c. A-21.1, s. 7 (retention schedule obligation); contents rules: Loi sur les services de santé et les services sociaux, RLRQ, c. S-4.2; model rule: BAnQ Recueil 2024, rule 10-106 | 2026-10-04 |

Notes on the health rows, all verified:

- Retention of user health records in Quebec public establishments is not set by a single statutory number. The Loi sur les archives (RLRQ, c. A-21.1, s. 7) requires each public body to adopt a retention schedule; BAnQ's Recueil (2024) is the official model, not itself a schedule ("le Recueil ... n'est pas un calendrier de conservation, mais ... un modèle qui facilite l'élaboration d'un calendrier de conservation par un organisme public (première exigence de l'article 7 de la Loi sur les archives)"). Each establishment's own approved schedule governs. Rule 10-010 states it applies across the network but an establishment may adapt it to a mission.
- The period genuinely varies by record subtype. The table covers the main dossier plus three verified subtype examples. Other subtypes in the 10-100 series (fetal monitoring tracings, transplant records, LPJ youth records, blood bank, etc.) have their own rules and are flagged "verify" until looked up per subtype.
- Not covered here and flagged for follow-up: private-sector health clinics (subject to Law 25 sector privé art. 23 plus professional order rules), and federal health-information contexts.

Notes on the other rows:

- ITA s. 230(6), (7), and (8) extend or suspend retention where an objection or appeal is filed, where the Minister demands longer retention, or shorten it with written permission. The 6 to 7 year range assumes none of those apply.
- The Quebec payroll register rule covers the LNT registration system or register (employee names, SIN, hours, wage rates, deductions, pay slips, and the other particulars listed in regulation s. 1). The longer 6 to 7 year EI, CPP, and tax windows still apply to the same payroll data for their own purposes.

Notes on event-anchored rows:

- Some verified rows are anchored to an event rather than a calendar date ("duration of services" for the main dossier, "after the user's death" for vaccination records, "after the last business transaction" for AML records). The "ranges only" rule still holds: the range states the duration measured from the anchor, and the anchor is named explicitly. In the recipe language this is the `set_retention` `anchor` field (e.g. anchor "after death" with range 5 to 6 years). An event-anchored entry never becomes a bare number.
- Source flag: the PCMLTFA s. 148 citation was verified against a Justice Laws search page quoting the provision verbatim (see Sources), not the section URL itself. Re-pin it to the section URL before Phase 3 consumes this row.

## What is not covered

Quebec Law 25 (the Act to modernize legislative provisions as regards the protection of personal information, formerly Bill 64, amending the Act respecting the protection of personal information in the private sector) **sets no retention periods**. It requires destruction or anonymization once the purposes of collection are fulfilled, "subject to" retention periods set by law, but it fixes none itself:

- The Commission d'accès à l'information (CAI), official guidance for businesses: "La seule restriction à cette obligation de destruction est le délai de conservation prévu par une loi." Source: https://www.cai.gouv.qc.ca/protection-renseignements-personnels/information-entreprises-privees/conservation-destruction-renseignements-personnels (consulted 2026-10-04).
- Lavery, summarizing amended s. 23: businesses must "détruire ou rendre anonymes les renseignements personnels recueillis lorsque les fins de la collecte ont été accomplies, sous réserve des délais de conservation prévus par une loi (art. 23)". Source: https://www.lavery.ca/fr/publications/nos-publications/4276-modifications-aux-lois-sur-la-protection-des-renseignements-personnels-ce-que-les-entreprises-doivent-savoir.html (consulted 2026-10-04).
- Fasken analysis: under the private-sector act, use after the file's purpose is accomplished is allowed only "sous réserve du délai prévu par la loi ou par un calendrier de conservation établi par règlement du gouvernement, calendrier qui n'a jamais été établi" (the regulation contemplated by art. 10 was never adopted). Source: https://www.fasken.com/-/media/0a1dc4fd27b6456ea6d32ca2e7779cff.pdf (consulted 2026-10-04).

Consequence for the retention rule spec: Law 25 contributes the trigger ("destroy or anonymize when the purposes are fulfilled") and the deferral ("subject to periods set by law"), and never contributes a number. Any period shown next to a Law 25 inventory item must come from a row in the table above or a similarly cited statute.

## Enforcement

1. Phase 3 vendor KB: every entry that implies a retention period must cite the statute name, section, and an as-of date, and state the period as a range per the convention above. Any entry that cannot cite a statute ships with a "verify" flag and no range. This applies to the Phase 3 vendor KB and to any later vendor KB entry.
2. Deploy checklist: re-verify the rule before each release. Check that every retention range still matches its cited statute (statutes amend; the as-of date is the audit trail), that no bare numbers remain, and that every uncited entry still carries its "verify" flag.
3. Re-verification cadence: the as-of dates above are 2026-10-04. Any row older than one release cycle must be re-checked against its source URL before the retention rule spec is marked current again.

## Sources consulted (verbatim URLs)

- https://laws-lois.justice.gc.ca/eNg/acts/I-3.3/section-230-20040831.html (ITA s. 230)
- https://laws-lois.justice.gc.ca/fra/reglements/c.r.c.,_ch._945/section-5800-20120101.html (Income Tax Regulations s. 5800)
- https://www.revenuquebec.ca/documents/fr/formulaires/fp/fp-500(2013-03)dx.pdf (Revenu Québec FP-500, 6-year record keeping)
- https://www.revenuquebec.ca/documents/fr/formulaires/vd/VD-350.56.IN%282023-04%29.pdf (quotes Loi sur l'administration fiscale s. 35.3, 6 years)
- https://www.publicationsduquebec.gouv.qc.ca/index.php?eID=dumpFile&t=f&f=39680&token=f2d28a76f57f2cc593b7598f9315b9b10d897214 (official Quebec interpretation bulletin on record retention)
- https://www.cnesst.gouv.qc.ca/sites/default/files/documents/grille-auto-inspection-tet.pdf?cid=1748530849 (CNESST self-inspection grid quoting R.R.Q., c. N-1.1, r. 6, s. 2 verbatim)
- https://laws-lois.justice.gc.ca/eng/acts/e-5.6/page-12.html (Employment Insurance Act s. 87)
- https://laws.justice.gc.ca/eng/acts/C-8/20130626/P1TT3xt3.html (Canada Pension Plan Act s. 24; archived consolidation)
- https://payroll.ca/getmedia/4912a082-8684-4ace-aee2-0635f2b5390f/NPI-Record-Retention-and-Electronic-Documents-Guidelines-Eng.pdf (quotes CPP Act s. 24(2) current text)
- https://laws-lois.justice.gc.ca/Search/Advanced.aspx?&ddC0nt3ntTyp3=Regulations&txtS3arch3xact=Under&h1ddC0nt3ntTyp3=1&h1dd3nPag3Num=1&txtT1tl3="Proceeds+of+Crime+(Money+Laundering)+and+Terrorist+Financing+Regulations" (Justice Laws search quoting PCMLTFR SOR/2002-184, s. 148(1))
- https://www.banq.qc.ca/sites/default/files/2024-06/Recueil_SSSS_2024_VF2.pdf (BAnQ Recueil des règles de conservation des documents des établissements de santé et de services sociaux, version 2024, rules 10-010, 10-101, 10-102, 10-106)
- https://www.cai.gouv.qc.ca/protection-renseignements-personnels/information-entreprises-privees/conservation-destruction-renseignements-personnels (CAI retention and destruction guidance)
- https://www.lavery.ca/fr/publications/nos-publications/4276-modifications-aux-lois-sur-la-protection-des-renseignements-personnels-ce-que-les-entreprises-doivent-savoir.html (Lavery on Law 25 amendments, art. 23)
- https://www.fasken.com/-/media/0a1dc4fd27b6456ea6d32ca2e7779cff.pdf (Fasken on retention under the private-sector act; no regulation ever adopted)
