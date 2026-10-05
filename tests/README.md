# tests/

1000+ unit and security tests for AI-data-map. One command runs everything:

```
node tests/run-all.js
```

Exit 0 means all green. No npm dependencies, no network, plain Node 18+.

## Layout

- `specs/` — frozen contract tests: recipe/token/state-snapshot/action-catalogue
  schemas plus the retention rule, positive and must-fail cases, driven through
  the real validators (`mcp/server.js`, chatbot `validateRecipeText`).
- `tokenizer-executor/` — JS/Python tokenizer byte-parity (68 handcrafted +
  200 seeded fuzz vectors, generators preserved), menu grounding, apply
  idempotency/tombstones/monotonic seq, done-heads, EN/FR narration.
- `chatbot-mcp/` — 384 chip-combo determinism, pasted-recipe rejections,
  MCP session lifecycle, error contracts, openapi.yaml drift checks.
- `import-export/` — parser/normalizer round-trips on real fixtures,
  broken-file and dangling-reference handling, SpreadsheetML structure with
  Review/Confirmations sheets, export re-import round-trip.
- `security/` — no-exfiltration static scan + runtime 0-request counter,
  XSS vectors, formula-injection, path traversal, prototype pollution,
  CSP hash coverage, dependency hygiene.

The runner also executes the pre-existing suites that live next to their
sources: `web/chatbot/chatbot.test.js`, `web/canvas/canvas.test.js`,
`web/import/engine/engine.test.js`, `web/import/worker/parse-core.test.js`,
`mcp/test-contract.js`.

## Conventions

Every test file: `"use strict"`, a header comment with its run command,
`global.self = global;` before requiring UMD modules, `require("assert")`,
counted assertions, a final `PASS <n>` line, `process.exitCode = 1` on
failure. New tests go in the matching subdirectory as `<topic>.test.js`.

## Known exceptions (documented, not hidden)

- The vendored onnxruntime bundle (`web/executor/vendor/ort/`) is excluded
  from naive grep hygiene: minified third-party code trips string scans.
  The check that matters is runtime behavior: the instrumented 0-request
  counter in `web/executor/js/net-guard.js` must read zero after a full run.
  See `security/no-exfiltration.test.js`.
- The Connections sheet of the SpreadsheetML export intentionally keeps the
  frozen Phase 1 shape (no draft banner row) so it re-imports with
  confidence 1.0; draft labeling lives on Nodes/Review/Confirmations.
- `executor.js` model-loop paths needing onnxruntime + the vendored model +
  fetch are covered by the Phase 6 rehearsal/acceptance runs, not unit tests.

## CI

`.github/workflows/test.yml` runs `node tests/run-all.js` on every push and
pull request. A red suite blocks the commit.
