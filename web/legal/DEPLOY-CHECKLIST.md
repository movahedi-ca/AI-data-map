# Deploy checklist (Section 10, working document)

100% means every box checked. A box is not checked unless its evidence exists. Statuses: VERIFIED (evidence recorded), PENDING-COUNSEL (blocked on the disclaimer sign-off), DEFERRED-TO-LAUNCH (can only complete at launch time).

Checked 2026-10-05 by Worker D (Phase 7, legal + launch docs).

## Boxes

- [ ] 1. Live on movahedi.ca at the guide URL, linked from the tools index (EN + FR).
  Status: DEFERRED-TO-LAUNCH. Evidence: none yet; this is the deploy step itself.

- [ ] 2. CSP hashes regenerated for all new scripts. Hash-based policy, no unsafe-inline.
  Status: DEFERRED-TO-LAUNCH. Evidence: procedure defined in web/canvas/INTEGRATION-NOTE.md ("CSP hashes" section); hashes are generated from the final deployed bytes at deploy time, so this box can only be checked then. The movahedi.ca Worker serves a hash-based enforced CSP with zero unsafe-inline/unsafe-eval in script-src.

- [ ] 3. Excel template and examples linked from the guide page.
  Status: DEFERRED-TO-LAUNCH. Evidence: the template file exists (Data-Inventory-Template.xlsx with filled examples, in the workspace files); the links land on the deployed guide page at deploy time.

- [x] 4. Model repo, dataset repo, and executor source public on Hugging Face, MIT, with model and data cards stating the limitations (Section 11).
  Status: VERIFIED. Evidence: opened both repos live 2026-10-05. Model: https://huggingface.co/movahedi-ca/s1-workflow-tiny (MIT; model card carries Model details, Intended use, Training data, Training run, Evaluation with the three gate numbers, Limitations: picks among given actions only, reflex not planner, recovery limited by training, encoding changes need retraining; files listed incl. eval-report.json). Dataset: https://huggingface.co/datasets/movahedi-ca/ai-data-map-teacher (MIT; data card carries purpose, scale, split rationale, record format, determinism; states fully synthetic, no personal data). Executor source: public in github.com/movahedi-ca/AI-data-map. Residual gap, recorded: the Section 11 publication-gate lines in the tool's own legal framing (draft aid, not legal advice; retention entries are ranges with statute citations and as-of dates; verify before use) are not yet on the cards; they are added when counsel signs off the disclaimer (box 7).

- [x] 5. Every retention entry verified against the retention rule (Section 6, Phase 0).
  Status: VERIFIED. Evidence: specs/RETENTION-RULE.md, rows verified 2026-10-04, all ranges with statute + section + as-of date, Law 25 section documents that Law 25 sets no numerical periods. vendor-kb/schema.json enforces the rule at the data level (ranges only, statute + section + as-of date, Law 25 never cited as the source of a numerical period). Scanned all vendor-kb/entries/*.json 2026-10-05: entries that cannot cite a statute carry "verify": true with explicit notes (e.g. "Law 25 sets no numerical retention periods, so any period used must cite another statute. Verify retention ... with counsel."); no bare numbers presented as statutory found. Standing rule: any row older than one release cycle is re-checked against its source before the rule is marked current again.

- [ ] 6. Draft labeling and disclaimer verified on all outputs, including the exported Excel file (Section 9).
  Status: PENDING-COUNSEL. Evidence in code: web/executor/js/exporter.js draftBanner, EN "DRAFT FOR REVIEW. Verify every row before use. Not legal advice." / FR "BROUILLON À RÉVISER. Vérifiez chaque ligne avant usage. Pas un avis juridique."; web/executor/js/i18n.js draftBadge "Draft for review" / "Brouillon à réviser"; "Draft for review" badge visible through the review and download steps. The final disclaimer copy (web/legal/DISCLAIMER-DRAFT.md) is not signed off; this box checks when counsel signs box 7 and the copy is confirmed in place on the page and in the export.

- [ ] 7. Counsel has reviewed and signed off the disclaimer and liability copy. No launch without it.
  Status: PENDING-COUNSEL. Evidence: web/legal/DISCLAIMER-DRAFT.md committed with a sign-off block (reviewer name, date, decision, changes required, signature); block is empty. This is the hard gate from Mohammad: no launch without a completed sign-off.

- [x] 8. Pre-launch DPIA complete, network-tab audit included, residual risks recorded (Section 9).
  Status: VERIFIED. Evidence: web/legal/DPIA.md committed 2026-10-05; covers data categories, memory-only storage (no localStorage/sessionStorage/IndexedDB/cookies, code-inspected), empty third-party script inventory, vendored provenance with hashes (onnxruntime-web 1.20.1, SheetJS xlsx 0.20.3), analytics scope (none on tool pages), Excel parsing of personal data, session-wipe completeness with residual limits, the network-tab audit procedure, and five residual risks recorded plainly. Audit evidence today: web/import/tools/qa-accept.mjs criterion G (localhost acceptance: console clean, zero failed requests, zero third-party scripts) and web/executor/js/net-guard.js (the live counter instrumentation). The live-site capture must be repeated at deploy and its result recorded here before launch.

- [x] 9. Zero third-party scripts on the tool page.
  Status: VERIFIED. Evidence: grep of web/canvas/demo.html and web/canvas/demo-fr.html 2026-10-05: every script src is a relative same-origin path (executor js, vendored ort.min.js, vendored xlsx.full.min.js, import engine, canvas); zero `https://` script references. This check must be repeated on the final deployed page at deploy time, because the deploy step is where third-party scripts could be introduced.

- [ ] 10. Launch writeup published: the eval numbers (Section 4) and the positioning (Section 1).
  Status: DEFERRED-TO-LAUNCH. Evidence: draft committed as web/legal/LAUNCH-WRITEUP.md 2026-10-05 (eval table: in-domain 0.9561, out-of-domain 0.9420, menu-permutation drift 0.00, train loss 0.2145, 1,382,017 params ONNX opset 17, 526 steps / 33 shards; positioning: OneTrust refugees and spreadsheet users; draft-for-review framing; honest limitations). Publishing is blocked on the counsel sign-off (box 7).

- [ ] 11. IndexNow ping and Search Console submission for all new and changed URLs.
  Status: DEFERRED-TO-LAUNCH. Evidence: none yet; runs after the page is live.

- [ ] 12. Announcement to the guide's existing audience.
  Status: DEFERRED-TO-LAUNCH. Evidence: none yet; runs after launch.

- [ ] 13. Offline bundle published to the Hub (Section 11).
  Status: DEFERRED-TO-LAUNCH. Evidence: none yet. Procedure defined in playbook Section 11 (single HTML file: inlined ort JS, base64 WASM, base64 weights; runs with the wifi off). The Hub repos exist; the single-file bundle upload is the launch step.

- [ ] 14. Release SHA-256 hashes published; Hub bytes match site bytes.
  Status: DEFERRED-TO-LAUNCH. Evidence: none yet; reproducible-build hashes are generated from the final release bytes at launch.

## Tally

VERIFIED: boxes 4 (with recorded card-line gap), 5, 8 (live re-capture required at deploy), 9.
PENDING-COUNSEL: boxes 6, 7.
DEFERRED-TO-LAUNCH: boxes 1, 2, 3, 10, 11, 12, 13, 14.

Not at 100%. The counsel sign-off (box 7) is the binding gate; boxes 6 and 10 unblock with it, and boxes 1, 2, 3, 11, 12, 13, 14 unblock at the deploy/launch step.
