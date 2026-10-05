# INTEGRATION-NOTE.md — Phase 1 import UI, how Phase 7 ships it

## What this is

The Phase 1 deliverable: a client-side spreadsheet import UI for the data
mapping guide. A filled inventory template goes in, a correct map comes out
on the builder canvas, and the existing Excel download keeps working. No
framework, no external requests, parsing in a Web Worker.

## Layout of this work

- `web-import/` — the shippable module tree. Committed to the repo under
  `web/import/`, served next to the guide page (the demo page loads it from
  the relative path `import/`, so the shipped page must serve the tree at
  `<page-dir>/import/`).
- `site-demo/` — throwaway local verification copy of `demo/` + integration.
  Never deployed as-is.
- `patches/0001-import-ui.patch` — import section HTML, `window.T.import`
  strings (EN + FR), CSS/JS includes. Applies to Tier B `demo/` with
  `patch -p1`.
- `patches/0002-builder-import-hook.patch` — the additive
  `window.DMImport.applyState` hook in `demo/assets/js/builder.js`.
- `patches/0003-exporter-row-order.patch` — the `bn-xls` exporter wrote the
  Nodes sheet as header, disclaimer, blank, data; the frozen format (freeze
  section 5, `buildSpreadsheetML`, the round-trip fixture) is disclaimer,
  blank, header, data. This patch moves the framing rows before the header
  so the site's own export round-trips with zero skipped rows. Without it,
  re-importing an export lists the disclaimer as a rejected "has no type"
  row. Verified via `tools/qa-accept.mjs` (captures the real download blob).
- `tools/` — `bundle-engine.mjs` (regenerates
  `web-import/engine/engine-bundle.js`), `make-fixtures.mjs`,
  `qa-smoke.mjs` (localhost-qa smoke driver), `qa-accept.mjs` (the full
  Phase 1 acceptance run: real template in, download capture, round-trip,
  broken file, CSV, FR incl. FR round-trip, hygiene).
- `fixtures/` — smoke-test files (not shipped).

## How Phase 7 applies it

1. `cd ~/workspace/data-mapping-interactive` (Tier B upstream) and apply
   both patches with `patch -p1`. Verify with `patch --dry-run` first.
2. Copy the whole `web-import/` tree to `demo/import/` (becomes
   `web/import/` in the repo). The 930 KB vendored
   `vendor/xlsx.full.min.js` is copied as a file, never patched; its
   SHA-256 is pinned in `vendor/SHA256SUMS`
   (`cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41`).
3. Regenerate Tier A via `build_astro.py` from the patched Tier B, per the
   normal Tier B -> Tier A flow.
4. Update the SHA-256 hashes in the freeze doc for: `demo/index.html`,
   `demo/fr.html`, `demo/assets/js/builder.js`, and the two Tier A pages.
   **This is the sanctioned spec bump: guide spec 1.0 -> 1.1.0.** The only
   behavior change is the additive `window.DMImport.applyState` hook; the
   node/edge model and the exporter format are untouched.
5. Regenerate the CSP hashes for every new script at deploy. New hashed
   scripts: `import/engine/engine-bundle.js`, `import/worker/worker-client.js`,
   `import/import.js` (classic scripts), plus the worker's own
   `importScripts("../vendor/xlsx.full.min.js", "parse-core.js")` — the
   worker script and its imports are same-origin local files, so no new
   `script-src` host enters the policy. No external requests anywhere.
   Recorded SHA-256 at Phase 1 verification (recompute at deploy if either
   file changes after this commit):
   - `web/import/engine/engine-bundle.js`:
     `e0048ec4407da9cda8ebd3b8d4dd81fb4f8bf9019c0c96a20c892e6f9a3516e3`
   - `web/import/import.js`:
     `accd45db73e7ab840b11d1ab2e5d4500b34f4228e22d8c21099e4c839dac089d`
6. Re-run `tests/builder-keyboard.test.cjs` (49/49 green with the hook) and
   the engine/parser suites before shipping.

## Contract notes for the verification worker

- Serve `site-demo/` over localhost (`python3 -m http.server` from `ui/`),
  then run `node tools/qa-smoke.mjs` with the localhost-qa MCP server.
  Playwright Chromium is required (`npx playwright-core install chromium`
  in the skill dir); the Meta Chromium at `/opt/meta-chromium/chrome`
  cannot render localhost pages in this environment.
- Fixtures: `fixtures/fixture-template-2sheet.xlsx` (sheet picker, mapping
  guesses, suggested categories, one dangling flow, one bad-type row, one
  near-duplicate name), `fixtures/fixture-systems.csv` (CSV path),
  `fixtures/fixture-export-roundtrip.xls` (the tool's own export format:
  must skip the mapping step, pre-fill categories "From your file",
  restore 3 nodes + 2 payment edges).
- The import section sits inside `#builder-app`, behind the existing T&C
  gate, exactly so the hook (`window.DMImport.applyState`, installed when
  the gate opens `initCanvas()`) always exists before the UI can call it.
- `engine-bundle.js` is generated; never hand-edit. Rebuild with
  `node tools/bundle-engine.mjs` after any engine change and re-pin the CSP
  hash.
- `web-import/worker/import-worker.js` differs from the parser original in
  exactly one integration line: `importScripts("../vendor/xlsx.full.min.js",
  "parse-core.js")` (path fix for the committed tree layout). Message
  contract unchanged.
- Category prefill rule: exporter `.xls` rows resolve display names through
  `DMEngine.mapCategoryDisplay` and are badged "From your file" (trusted
  file content, not a guess). Template flows carry engine proposals badged
  "Suggested" with the keyword reason, and stay suggestions until the
  visitor confirms. "Build map" stays disabled until every flow has a
  category.
