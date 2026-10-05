# Phase 3 verification report

Fresh-worker spot check of the vendor knowledge base, completed 2026-10-05.
Method: random sample of 20 entries (seed 42, 5 per chunk file), each re-checked
against its website and at least one listed source.

## Result

**16 PASS / 20 (80%). Zero FAILs. Four PARTIALs, all fixed below.**

Law 25 retention check across all 20: CLEAN. No entry attributes a numerical
retention period to Law 25. All `retention_features.claims` arrays are empty;
every Law 25 note states Law 25 sets no numerical retention periods.

## Sample

- a-privacy-suites.json: possiblenow, securiti, onetrust, dataguard, mine (all PASS)
- b-consent.json: cookiescript, iubenda, crownpeak, termly, dataships
- c-discovery-dspm.json: upwind, borneo, normalyze, dasera, monte-carlo
- d-dsr-grc-records.json: vanta, drata, secureframe, ibm-openpages, filetrail

## Fixes applied

1. `filetrail`: acquired by Litera on 29 July 2024 (Legal IT Insider). Description
   now notes the acquisition and the FileTrail by Litera branding; headquarters
   marked as Austin at acquisition with Litera ownership noted; acquisition
   source added.
2. `crownpeak`: acquired by Rezolve Ai, announced 1 December 2025 (KMWorld).
   Description notes the acquisition and that crownpeak.com now serves Rezolve Ai
   content; acquisition source added. The 2017 Evidon acquisition claim verified
   accurate and unchanged.
3. `ibm-openpages`: website corrected to https://www.ibm.com/openpages;
   description and headquarters now record the Waltham, Massachusetts origin and
   the 2010 IBM acquisition, with Armonk noted as IBM corporate HQ.
4. `dasera`: website corrected to the vendor's own https://www.dasera.com/;
   headquarters corrected to Mountain View (LeadIQ street address, SaaS News)
   with a note that the vendor's own 2022 release used a Sunnyvale dateline;
   LeadIQ's report of a 2024 Netskope acquisition recorded as reported, not
   confirmed.

## Flags (not fixed, recorded)

- `borneo`: website https://borneo.io could not be live-verified (DNS resolution
  failure at check time). All feature and founder claims were corroborated via
  the SourceForge comparison page. Re-check the URL before relying on it.
- Schema observation (from research): several vendors were acquired after their
  entries' original sources (WireWheel/Osano, Soveren/SecureSky, Tugboat
  Logic/OneTrust, Gimmal/Morae, DPOrganizer/DataGuard). A future schema pass
  could add an `acquired_by` / `active` flag. Entries record acquisitions in
  their descriptions where found.
