# FINDINGS.md - the fix-cycle queue

Every finding the nightly deep scan surfaces lands here. The weekly fix cycle
picks up open items, fixes or dispositions them, and flips their status.
Nothing here is allowed to sit in `open` at `critical` or `high` severity
without a dated disposition note.

## Status values

- `open` - triaged, awaiting a fix.
- `fixed` - fixed and committed (commit hash in the note).
- `accepted` - not a bug; reason recorded, re-check on the next relevant change.
- `false-positive` - the rule misfired; note why, and whether the rule needs tuning.

## Queue

| id | date | layer.rule | severity | file:line | status | note |
|----|------|------------|----------|-----------|--------|------|
| F-001 | 2026-10-05 | 2.exfiltration-sink | info | web/executor/js/executor.js:117 | accepted | Deliberate: same-origin fetch of the vendored model bundle, sha256-verified in browser before use. In filter.js ALLOWLIST (lineRe /same-origin/); the finding reappears if the line changes shape. |
| F-002 | 2026-10-05 | 2.exfiltration-sink | info | web/canvas/tools/qa-canvas.mjs:67 | accepted | QA harness only: fetches a fixture from the local dev server under test. The harness itself asserts zero non-localhost requests. In filter.js ALLOWLIST. |
| F-003 | 2026-10-05 | 2.formula-injection | info | web/executor/js/exporter.js:49, web/import/engine/spreadsheetml-parser.js:172 | accepted | Compensating control, not a missing guard: every cell is emitted as `<Data ss:Type="String">` with no `ss:Formula` attribute, so spreadsheet apps treat content as text. Asserted by tests/security/formula-injection.test.js (41 assertions, hostile vectors incl. DDE payloads, round-trip verbatim). In filter.js ALLOWLIST with a lineRe guard on ss:Type="String"; the finding reappears if the cell writer changes. Note: the rule message overstates the Excel behavior for String-typed cells; refined only if the rule is rewritten. |
| F-004 | 2026-10-05 | 1.debug-log | medium | tools/*.js (15 hits) | fixed (rule refined) | Triage showed all 15 hits were legitimate CLI output (console.log is the output channel of generate-templates, validate-templates, submit-indexnow). The rule was narrowed to shipped code only: web/ + mcp/, excluding *.test.js. The rule now reports zero and gates CI cleanly; the refinement is documented in lint.js and the layer1 README. |
| F-005 | 2026-10-05 | 3.duplicate-block | low | 115 repeated bodies (one finding per body, each appearing in 2+ locations; 94 reference bundle paths) | accepted | Expected by design: web/site-integration/bundle/ is the vendored shippable copy of web/executor/ + web/chatbot/ for the movahedi.ca integration (hash-pinned in SHA256SUMS). The remainder is repeated test/scenario helpers in teacher/. Slop signal only; dedupe only if a bundle drifts. |
| F-006 | 2026-10-05 | 3.unused-export | low | web/import/engine/engine-bundle.js:832 | accepted | Generated bundle mirrors the source module's public exports; `LAYOUT` is exported and consumed from the source (web/import/engine/state-builder.js) and kept as public API surface of the bundle. Removing it would mean touching the bundler for zero runtime effect. |
| F-007 | 2026-10-05 | 3.wrapper-function | low | 3 sites (teacher/lib/executor.mjs `touches`, web/import/engine/engine.test.js `edgeKey`, +1) | accepted | Thin delegating helpers kept for readability at call sites. Slop signal only. |
| F-008 | 2026-10-05 | 1.em-dash | high | web/site-integration/DEPLOY-NOTE.md:24 | fixed | Literal U+2014 replaced with a comma. Commit with this pipeline. |

## How the weekly fix cycle consumes this

1. Read the table. Take every `open` row, highest severity first.
2. Fix the code (or the rule, for false positives) in a normal commit.
3. Update the row: status, commit hash or reason, date.
4. Re-run `bash scanning/nightly.sh`; the row's finding must be gone or suppressed.
5. If a `critical` or `high` finding cannot be fixed within the week, the row keeps
   `open` but gains a dated note explaining the plan. Two consecutive weeks with
   no movement escalates to a build-priority decision.

## Rules of the queue

- Findings are never deleted, only re-stated. History matters.
- A suppression comment in code (`// scan-allow: <rule-id> <reason>`) must name
  the FINDINGS row id it answers to.
- The nightly CI workflow runs `bash scanning/nightly.sh` and uploads the
  timestamped report as an artifact; it does not fail the build on findings,
  but a human reads the summary every morning.
