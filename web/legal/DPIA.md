# Pre-launch DPIA: data mapping assistant

Date: 2026-10-05. Status: complete as a document. The live-site network-tab capture must be repeated at deploy before launch (see Section 8).

This DPIA covers the client-side data mapping assistant on movahedi.ca: the four-tap recipe builder, the in-browser System-1 executor, the spreadsheet upload path, the draft Excel export, and the one-click session wipe. It exists to be read by a person deciding whether to trust the tool with their organization's data.

## 1. Data categories

What the tool can hold, in memory only, during a session:

- The four intake answers (organization size band, sector, region, data types), tapped as chips. No free typing is required to start.
- Map state: nodes (systems, vendors, data categories), edges (data flows), categories, and the review checklist with the visitor's confirm-or-fix decisions and corrections.
- Uploaded spreadsheet contents. A visitor may upload a filled inventory template or any spreadsheet. This is the sensitive path: the file may contain personal data (employee names, contact details, customer data categories, vendor contact names, access logs). The file is parsed locally and never transmitted.
- The narrated step log and the confirmation record exported alongside the draft Excel file.

## 2. Storage

- Memory only. The tool writes nothing to localStorage, sessionStorage, IndexedDB, or cookies. Verified by code inspection of web/executor/js/*.js, web/import/import.js, and web/canvas/canvas.js (no persistent-storage calls present).
- A page reload loses the session. This is by design.
- The only data that leaves the page is what the visitor explicitly downloads (the draft Excel file) or copies out themselves.

## 3. Third-party script inventory (tool pages)

Empty. All scripts on the tool page are same-origin, loaded from relative paths:

- web/executor/js/net-guard.js (loaded first, instruments the request counter)
- web/executor/js/* (executor, UI, exporter, review, i18n, templates, narrate, menu, apply, s1util, s1tokenize)
- web/executor/vendor/ort/ort.min.js (vendored, see Section 4)
- web/import/vendor/xlsx.full.min.js (vendored, see Section 4)
- web/import/import.js, web/import/engine/*, web/canvas/canvas.js

Evidence: grep of web/canvas/demo.html and web/canvas/demo-fr.html shows zero `https://` script references. This check must be repeated on the final deployed page at deploy time, because the deploy step is where third-party scripts could be introduced (site templates, tag managers, consent banners).

## 4. Provenance of vendored runtimes

onnxruntime-web 1.20.1 (MIT, Microsoft). Source: npm package onnxruntime-web@1.20.1, files taken from dist/. Sidecars fully vendored. Hashes from web/executor/vendor/VENDOR-MANIFEST.md:

| File | SHA-256 |
|---|---|
| ort.min.js | be6e560b64c03c99252eedc0e1989e9e51e44d9f191e7655c9bf011bf9f576c8 |
| ort-wasm-simd-threaded.mjs | 745eb7c0ce6f18a6aa521971b2877babc7ffb27eecb58ab3bc6e5ef4692672e8 |
| ort-wasm-simd-threaded.wasm | 207d02be4591c156b0a98f024f3d58005b5b04c92274d759fb390338c63559ea |
| model.onnx | f5f15612c294b37955d416aafdfccd127361ee2bddc509d3c6ea3eefdbe1de62 |
| model.onnx.data | a2cdac628fedd2c98c2c304493a78ea2637fe8d20eb3149e271807a1e479ecad |

The WebGPU backend bundle (ort.webgpu.bundle.min.mjs and its sidecars) is NOT vendored. The executor runs the WASM SIMD-threaded path, which requires COOP/COEP headers for SharedArrayBuffer on the host page. If the headers are absent the threaded wasm path fails; this is a functionality issue, not a data one.

SheetJS xlsx.full.min.js 0.20.3 (Apache-2.0, community edition). Source: https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js, pinned 2026-10-04. SHA-256: cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41. Pinned from the project's own origin only, so no new script-src host ever enters the CSP. Named fallback if this build ever goes bad: ExcelJS (maintained, MIT). Known fact, recorded plainly: SheetJS is in maintenance mode upstream, which is why the build is pinned with a recorded hash and why the SpreadsheetML export path uses its own custom parser (exports never depend on SheetJS).

## 5. Analytics scope

None on the tool pages. The tool sets no cookies, runs no analytics script, and sends no telemetry. Site-wide analytics on movahedi.ca is on hold by standing decision; if site analytics are ever re-enabled, the tool page must either stay excluded or this DPIA must be updated and the network-tab audit re-run before the change ships.

## 6. Excel parsing of potentially personal data

- Parsing happens entirely in the visitor's browser: SheetJS for .xlsx uploads, the custom SpreadsheetML parser for the site's own export format round-trip.
- Spreadsheet formulas and macros are never executed. Parsing reads cell values only.
- The uploaded file is processed in a Web Worker and read into memory; no copy is made to any server, and none is written to persistent storage.
- The import engine validates the sheet and flags broken files inline (wrong columns, missing required fields) instead of silently guessing. Nothing about the file's contents is logged anywhere.

## 7. Session-wipe completeness

One click wipes the session (web/executor/js/ui.js, wipe()):

- All in-memory state resets (chips, template, checklist, confirmations, corrections, review flags).
- The canvas, step log, and review list DOM are cleared; the canvas state is reset through the import layer.
- Because nothing was ever written to persistent storage, there is nothing to purge beyond memory. Wipe ends with "Wiped. Nothing persists." (EN) / "Effacé. Rien n'est conservé." (FR).

Residual limits, recorded plainly:

- Wipe cannot remove files the visitor already downloaded (the draft Excel in their Downloads folder) or text they copied out of the page.
- Wipe cannot erase OS-level traces outside the page (browser page cache, swap). The tool holds no persistent data of its own; what the browser itself retains is the visitor's own device matter.

## 8. Network-tab audit

Procedure (repeat at every deploy, before launch):

1. Load the deployed tool page with DevTools open, network tab recording, cache disabled.
2. Run the full flow: four taps, template upload, review loop with a correction, draft Excel download, session wipe.
3. Assert: zero requests whose destination origin differs from the page origin. Same-origin loads of the page's own vendored assets (scripts, wasm, model) are page loads, not data leaving the device.
4. Read window.__s1net.count() (web/executor/js/net-guard.js, loaded first) and confirm it reads zero after the full run.

Where the evidence lives:

- web/executor/js/net-guard.js: the instrumentation that powers the live "0 requests sent" counter on the page.
- web/import/tools/qa-accept.mjs, criterion G: the localhost acceptance run checks "console clean, zero failed requests, zero third-party scripts" against the real page in a real browser.

Current evidence: the localhost acceptance check covers the criteria above. The live-site capture does not exist yet because the page is not deployed yet. The live capture must be run at deploy and its result recorded in the deploy checklist before launch. The privacy claim on the page is only as good as the most recent capture of the deployed build.

## 9. Residual risks, recorded plainly

1. The qualified privacy claim on the live page rests on same-origin asset loads and the audit of the deployed build. If the host page's serving setup changes (a CDN, a proxy, a template change that adds a script), the claim must be re-audited. The checklist makes this a deploy-gate item every release.
2. Retention ranges in specs/RETENTION-RULE.md are statutory floors verified 2026-10-04. Statutes get amended. Any row older than one release cycle must be re-checked against its source before the retention rule is marked current again.
3. The vendor KB is research, not advice. Entries that cannot cite a statute carry "verify" flags and explicit notes (including the note that Law 25 sets no numerical retention periods). A visitor who treats a verify-flagged entry as settled is misusing the tool; the draft labeling and the review checklist are the guardrails.
4. The SheetJS pin is deliberate because upstream is in maintenance mode. The recorded hash and the named ExcelJS fallback are the mitigation.
5. No DPIA can cover what the visitor does with their download. The exported Excel file is a draft for review; the disclaimer inside the file says so, and counsel reviews it before launch.
