# DMCanvas (Worker 1, Phase 2, canvas core)

`canvas.js` is a classic script (`"use strict"`, no modules, no dependencies, no
network). It owns the map viewport for the data-mapping tool. `canvas.test.js`
runs with `node canvas.test.js` (46 assertions, green).

## API

`window.DMCanvas.init({ wrapId, svgId, statusId, strings })` returns
`{ applyState, getView, setView, fitView, destroy }`, or `null` when the wrap or
svg element is missing.

- `applyState({nodes, edges})`: replaces all content, clears selection, redraws,
  then fits the view. `nodes` is id -> `{type, x, y, label}` with types
  `collection | system | thirdparty | destruction`; `edges` are `{a, b, cat}`
  with cats `contact | payment | marketing`. Accepts the extra `seq` that
  `buildState` returns; it is ignored.
- `getView()` / `setView({k, tx, ty})`: k is clamped to [0.35, 3] on set.
- `fitView()`: bounds of all nodes plus 60px node padding, fitted into the
  wrap size with 48px margins, k clamped to [0.35, 3].
- `destroy()`: removes every listener, removes the `#dm-viewport` group and the
  pseudo-fullscreen class, unhooks `DMImport.applyState` when it is ours.

`init` creates `<g id="dm-viewport">` inside the svg and renders into it.
It also sets `window.DMImport = window.DMImport || {}` and
`window.DMImport.applyState = applyState`; import.js reads that lazily at
Build click, so the page must call `DMCanvas.init` before the user builds.

`init` also sets on the svg: `role="application"`, `tabindex="0"`,
`aria-label` from `strings.canvasLabel`, and a `touch-action: none` JS fallback
(Worker 2 sets it in CSS as well). Status text goes to `statusId` when present.

## DOM contract (as built)

- wrap `#canvas-wrap` is the fullscreen target.
- Toolbar buttons are all optional and guarded: `#cv-zoom-in`, `#cv-zoom-out`,
  `#cv-fit`, `#cv-full`. When present they get localized `aria-label`s; the
  fullscreen button label and `aria-pressed` sync on `fullscreenchange`.
- Node visuals are a faithful port of the builder renderer: same
  `shapeFor()` shapes per type (collection circle r24, system rect 104x48 rx8,
  thirdparty diamond, destruction dashed circle + X), invisible tap halos,
  `.node` / `.shape` / `.node-label` classes, edge paths with the identical
  28/32 trim math and `class="edge <cat>"`. The guide CSS should apply unchanged.
- Nodes are `<g tabindex="0" role="button" aria-label="type: label">`;
  Tab order is insertion order. Clicking a node (tap under 4px movement)
  selects it; Enter/Space toggles. Selected nodes carry class `selected`.
  Status announcements: `Selected: <label>` / `Deselected`.

## Keyboard map

| Key | Action |
|---|---|
| `+` / `=` | zoom in (x1.25), centered on view center |
| `-` / `_` | zoom out (/1.25), centered on view center |
| `0` | fit map to view |
| `f` | toggle fullscreen |
| Arrow keys | pan 40px in the pressed direction (Shift: 160px) |
| Escape | exit pseudo-fullscreen (native Esc exits natively) |
| Enter / Space (on a focused node) | toggle selection |

Zoom/pan keys only fire when the svg itself has focus, not a node and not a
form field. Wheel over the svg zooms to the cursor (`preventDefault`,
non-passive listener); page scroll outside the canvas is unaffected.
Two-pointer gestures: pinch zooms around the pinch midpoint, two-finger drag pans.
Pan is pointer drag on the background (not starting on a node) with a 4px
click-vs-drag threshold; drags that start on a node do nothing, so taps select.

When a node receives focus, the view pans just enough to bring the whole node
(including its label) into view with an 80px margin, without changing zoom.

Fullscreen: `wrap.requestFullscreen()` when `document.fullscreenEnabled`,
otherwise a `.cv-pseudo-full` class on the wrap (Worker 2 styles it
`position: fixed; inset: 0`). Redraws happen only on `applyState` and selection
change; pan/zoom only update the viewport transform. View changes are announced
sparingly (fit, fullscreen toggles), never per pan.

## Strings

`opts.strings` overrides EN defaults. Keys: `zoomIn`, `zoomOut`, `fitView`,
`fullscreen`, `exitFullscreen`, `selected`, `deselected`, `mapFitted`,
`canvasLabel`. Plain words, no em dashes anywhere in code or strings.

## Notes for Worker 3 (acceptance)

- Drive via `window.DMCanvas.init(...)` then `applyState` with a state shaped
  like the phase-1 `buildState` output: node coords live in x 40-600, y 40-380
  (the builder clamp); `fitView` handles any bounds, including empty.
- Pure math is exposed as `window.DMCanvas.pure` (and via `module.exports` in
  Node): `clampZoom`, `worldToScreen`, `screenToWorld`, `contentBounds`,
  `fitTransform`, `zoomAround`, `panToKeepVisible`, `nodeWorldRect`, plus the
  constants. Use these for headless acceptance of the math; use `getView` /
  `setView` plus DOM inspection (`#dm-viewport` transform, `.selected` classes)
  for page-level checks.
- Edge cases already covered in tests: zoom clamp edges (0.2 -> 0.35, 5 -> 3,
  NaN/0/negative -> 0.35), cursor-anchored zoom (also at the clamp edge),
  round-trip world/screen, fit of the full 680x460 padded bounds into
  1280x800 (k ~1.53, inside margins) and 360x640 (k ~0.39, above min),
  pan-to-keep-visible from all four sides with k scaling, empty/null state.
- One DOM-contract change to flag: the svg gets `tabindex="0"` from `init`
  (the builder svg was not keyboard-focusable), so arrow/zoom keys are active
  whenever the svg has focus. If the page embeds other focusable controls
  inside the svg, keys other than Enter/Space on nodes fall through to the
  svg handler only when `evt.target === svg`.
- Known limit: `applyState` always refits the view. If a later phase needs to
  preserve the current zoom across state updates, call `getView()` before and
  `setView()` after `applyState`.

## Coordinator addition: spreadColumns (de-overlap on applyState)
The import pipeline stacks same-type nodes in fixed-x columns (80/310/545, y 80-320). A 45-node map packs ~15 nodes per column at ~17px spacing while a node is ~48px tall, so without a layout pass the map is an unreadable blob and the "comfortably explorable" exit fails. `applyState` now runs the pure `spreadColumns(nodes)` first: group by exact x, sort by y, enforce a 96px minimum vertical gap by pushing down, then recenter the column on its original center. Deterministic, order-preserving, a no-op when spacing is already wide; input objects are never mutated (applyState copies node fields). This is a presentation-layer layout in the canvas module, not a change to the frozen node model. 13 new assertions in canvas.test.js (59 total green).

## Worker 3 addition: sub-column wrapping (2026-10-04)
Acceptance found that a 20-node spread column spans ~1900 world units, which needs k ~0.19 to fit, below the 0.35 zoom floor, so fit-to-view left nodes off-screen. `spreadColumns(nodes, maxChunk)` now wraps a column taller than a fit-to-view at the minimum zoom into side-by-side sub-columns (SUBCOL_DX 170px apart, centered on the original x), each keeping the 96px vertical gaps and sharing one vertical span recentered on the original center. `applyState` derives maxChunk from the live wrap height: `floor(((h - 96) / 0.35 - 120) / 96) + 1` (10 for a 462px wrap). The second argument is optional; one-arg calls behave exactly as before, so the earlier assertions still pass. 9 new assertions in canvas.test.js (68 total green).
