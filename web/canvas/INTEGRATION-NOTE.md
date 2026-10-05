# INTEGRATION-NOTE.md - Phase 2 canvas page + styles (Worker 2)

## What this is

The Phase 2 Worker 2 deliverable: the verification pages and stylesheet for
the new zoom/pan/fullscreen canvas module. Worker 1's `canvas.js` (the
viewport engine) lives in the same working directory; Worker 3 drives the
acceptance run. Nothing here is committed to the repo yet; the coordinator
commits.

## Layout of this work

All files are in
`~/workspace/goals/taiga-style-data-mapping-agent-on-movahedi-ca/hidden_files/phase2/canvas/`.

- `canvas.js` - Worker 1: the viewport engine (`window.DMCanvas`). Not mine;
  see that worker's NOTES.md for its API and the DOM-contract changes it made
  (the svg gains `tabindex="0"`, so arrow/zoom keys fire when it has focus).
- `canvas.test.js` - Worker 1's node tests (46 assertions). Not mine.
- `NOTES.md` - Worker 1's API/contract notes. Not mine.
- `canvas.css` - Worker 2 (mine): toolbar overlay, canvas frame,
  `:fullscreen` and `.cv-pseudo-full` states, node focus/selection rings,
  label halo, per-category edge dash patterns, night-ledger dark-mode
  mirrors, and the throwaway demo chrome (`.cv-demo`-scoped, not shipped).
- `demo.html` / `demo-fr.html` - Worker 2 (mine): verification pages with
  the Phase 1 import-flow UI markup (file -> sheets -> mapping -> review ->
  build -> done, ids and copy carried over verbatim) plus the new
  `#canvas-wrap` toolbar contract, and the script load order:
  `../import/engine/engine-bundle.js`, `../import/worker/worker-client.js`,
  `../import/vendor/xlsx.full.min.js`, `canvas.js`, `../import/import.js`.
- `INTEGRATION-NOTE.md` - this file.

## How Phase 7 applies it

Commit this tree as `web/canvas/` next to Phase 1's `web/import/`; the demo
pages resolve the import tree at `../import/` (engine, worker-client, vendor,
import.js), so the relative layout must stay: `web/canvas/demo.html` beside
`web/import/...`. The demo pages are throwaway verification (like Phase 1's
`site-demo/`), not deployed pages.

`window.T.canvas` (defined inline before `canvas.js` loads) carries the ten
toolbar/viewer strings: `zoomIn, zoomOut, fitView, fullscreen, exitFullscreen,
selected, deselected, mapFitted, canvasLabel, toolbarLabel`. The demo's
`DOMContentLoaded` handler calls `window.DMCanvas.init({wrapId: "canvas-wrap",
svgId: "builder-canvas", statusId: "cv-status", strings: window.T.canvas})`
with a guard so the page survives if `canvas.js` is ever missing. Worker 1's
`init` installs `window.DMImport.applyState`, which `import.js` reads lazily
at Build click, so import -> canvas wiring needs no other glue.

Palette: the archival ledger, not a new theme (`--paper #f8fafc`,
`--ink #0f172a`, teal `#0e6e64`, vermilion `#b3401f`), verified against
Phase 1's `ledger.css`. Every palette use reads the ledger variable with a
light-mode fallback so `canvas.css` renders standalone on the demo pages and
picks up the night-ledger (`html.dark .dm`) overrides on the guide. Node
labels are 14px with a `paint-order: stroke` halo in the canvas background
color so they stay legible at Worker 1's 0.35 minimum zoom. Edges keep the
builder convention: one color, meaning in the dash pattern
(contact solid, payment 7 4, marketing 2 4), matching `edge.*` classes.

## CSP hashes

SHA-256 of the files as delivered (recompute at Phase 7 deploy if anything
changes after this write). Whole-page hashes; the inline `window.T` /
`DOMContentLoaded` scripts in the demo pages are covered by the page hash.

- `web/canvas/canvas.css`:
  `7061fc9dc30412d48a98d996b272b4089650fc2bf410af58988d7752f6118b80`
- `web/canvas/demo.html`:
  `6dde1c6ca594f0bb52ba8e29a64cc199e1d3646d1a1dacb7c28d60d59cffaea7`
- `web/canvas/demo-fr.html`:
  `47e883f68e8b511a3b87317371ff3f86c47ca5913daf872f36bbbbb8f1c19773`
- `web/canvas/canvas.js` (Worker 1):
  `0cf2c12ffb2176a8f685b018dc52aa51e07e79311129b66fab26548066d0769e`

Hygiene verified on my three files: tag-balanced HTML (parser scan, zero
errors), zero external URLs, zero em dashes.

## Contract notes for the coordinator / verification worker

- The DOM contract held as specified: `#canvas-wrap` >
  `#cv-toolbar[role=toolbar][aria-label]` (4 buttons: `#cv-zoom-in`,
  `#cv-zoom-out`, `#cv-fit`, `#cv-full`) + `svg#builder-canvas` +
  `p#cv-status[role=status]`. Button labels are set by Worker 1's
  `canvas.js` from `window.T.canvas` at `init`; my markup carries EN/FR
  defaults so the toolbar is labeled even if the script never runs.
- One deliberate deviation from the brief: `#builder-canvas` uses
  `height: 420px` (capped at `70vh`), not `height: auto`. With `auto` the svg
  collapses until Worker 1's JS sets dimensions, and Phase 1's builder used
  420px; this keeps first paint identical to the shipped guide.
- Legal framing is the Phase 1 disclaimer carried over verbatim:
  EN "Illustrative working draft only. Not legal advice; verify retention
  obligations independently." / FR "Brouillon de travail illustratif
  seulement. Pas un avis juridique; vérifiez vos obligations de conservation
  de façon indépendante." It was not reworded.
- Flag for Worker 1: `canvas.test.js` contains one U+2014 em dash (my files
  are clean). The project standing rule bans em dashes; the test file should
  be fixed before commit.
- To serve locally for Worker 3: place this tree so `../import/` resolves to
  the Phase 1 `web/import/` tree (e.g. serve `web/` over localhost and open
  `/canvas/demo.html`). The import worker loads
  `import/worker/import-worker.js` relative to `worker-client.js`, same as
  Phase 1.
