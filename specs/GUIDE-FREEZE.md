# Guide Freeze Snapshot (Phase 0 baseline)

Interactive data-mapping guide on movahedi.ca, built 2026-09-30. Snapshot date: 2026-10-04.
This document is the freeze baseline for the scripted executor. Everything below describes the guide exactly as deployed at the two canonical page sources.

## 1. File manifest (SHA-256)

Tier A: canonical frozen sources. The guide as deployed is generated from these two files; they carry the DOM, the shipped CSS, the i18n strings, and all JS inline.

| File | SHA-256 |
|---|---|
| `movahedi-ca-deploy/src/pages/tools/data-mapping-guide/index.astro` (EN page) | `c1f11fd2f8b916df6124eaf1990cc88818c2a22b88c14c30fb0b37481bb8e21d` |
| `movahedi-ca-deploy/src/pages/fr/outils/guide-cartographie-donnees/index.astro` (FR page) | `a00990671cfc984a150014be48e5a9c254752c86caa4c514a7f3a30fc2bee0b1` |

Tier B: upstream working copies in `~/workspace/data-mapping-interactive/` (JS behavior matches the shipped pages; see the sync audit).

| File | SHA-256 |
|---|---|
| `demo/index.html` (EN template + `window.T` EN strings) | `8ae017036af085cd7648c12ee70a983f842861a1fce5244001a1d80a4c6c8d6f` |
| `demo/fr.html` (FR template + `window.T` FR strings) | `57f2e0e94ff89f8757554a221858fd4a8f2b65204661644b5be6ace7762f8c0f` |
| `demo/assets/js/rules.js` (retention rules dataset + statute chips) | `3b1ad9a103012c4ba3a4d00f89d78b316abaed4c8fe6dd5b323f2d751a78dd4c` |
| `demo/assets/js/simulator.js` (v1 retention timeline simulator) | `4862b54394d179026c311f3c7096b5a615b65157520b5c48a61a5e54cf694329` |
| `demo/assets/js/walkthrough.js` (v2 Café Nord step-driven SVG diagram) | `d41ce0c86f4c06693d4a6a552652b1407e07284a671a36d382e845da3d165667` |
| `demo/assets/js/export.js` (v2 CSV export pack) | `a08e19a3e5b037e43b6d04701527217eb04b1df6a3735213d656d7dde9372554` |
| `demo/assets/js/builder.js` (v3 blank-canvas builder + SpreadsheetML export) | `25305fb233e1450fd831f0655844c229e89fcf341aebb13e61cf5d490d67096c` |
| `demo/assets/css/ledger.css` | `3f2344a54e15ab27200f987d832f25b26f94d5f1f960e6f6c0c909d419e988b4` |
| `build_astro.py` (demo to Astro page generator) | `923ec4d4a521f7671572bfb2707035ddcc5bc53cb157af1512c1c12d57542610` |
| `tests/builder-keyboard.test.cjs` (DOM-stub contract tests for builder.js) | `a47be1cd5db7e11fc3bf61e92d90e9100f743a478d3ba3b4c8b29e92106bfc9d` |
| `tests/legend-css-scope.test.cjs` | `4ef174d467ef7dcac291f12e1afcba7d12928a6754af269a2b8f3e3db3b54537` |
| `BUILD_PLAYBOOK.md` | `8c83e19db5f8fc97304e99f41f98553c2ec952957affd5a5554ba97b542e8248` |
| `CONCEPT_BRIEF.md` | `d1d62d955ca4fa6fd5e3f9fcb4a18e2ece23e62a4e987b9847cc1f712487e182` |
| `INTEGRATION.md` | `0819dbac0a77bbe2cf3fec65521207ff59ede9b4f5195ceb9a2469ae98b1cbc3` |

Built output (reference only; asset bundle names change per build, so do not freeze on these):
- `movahedi-ca-deploy/dist/tools/data-mapping-guide/index.html` (built 2026-10-04 12:49 EDT)
- `movahedi-ca-deploy/dist/fr/outils/guide-cartographie-donnees/index.html`

### Sync audit: upstream demo vs shipped pages

Verified by regenerating from the demo with `build_astro.py` and diffing against the shipped `.astro` files:

- JS behavior: identical. The only diffs are the header comments of `simulator.js`, `walkthrough.js`, `export.js`, and `builder.js` (the shipped pages use a colon where the demo has an em dash, from the no-em-dash ship rule). `rules.js` matches byte for byte.
- DOM body: identical apart from the two cross-language `href` rewrites (`fr.html` to `/fr/outils/guide-cartographie-donnees/` and back).
- CSS: DIVERGED. `demo/assets/css/ledger.css` is stale. The shipped pages carry a rewritten stylesheet (14,762 bytes) keyed to the revamp editorial token system (`.rv-tool` scope; only `--danger: #b3401f` added). Do not use `ledger.css` as a styling reference; treat the CSS inside the Tier A files as canonical. All class names the JS depends on (`.node`, `.edge`, `.contact`, `.payment`, `.marketing`, `.selected`, `.hit`, `.shape`, `.node-label`, `.step-dot`, `.chip`, `.chip-note`, `.printing-builder`) exist in the shipped CSS.

## 2. DOM / JS API surface

### Page structure

Both pages wrap the whole guide in `<div class="dm">` (CSS scope root; the revamp editorial scope is `.rv-tool`). All guide JS is inline `<script is:inline>`; there are no external JS files, no libraries, no workers. Every script is an IIFE. No zoom, no pan, no fullscreen anywhere in the guide.

Element IDs (identical on EN and FR pages):

| ID | Role |
|---|---|
| `sim-category` | `<select>` for the retention simulator record category |
| `sim-output` | simulator result region |
| `walkthrough` | walkthrough section wrapper |
| `walk-svg` | Café Nord SVG diagram (`viewBox="0 0 640 480"`, `role="img"`, `tabindex="0"`) |
| `walk-caption` | step caption, `aria-live="polite"` |
| `walk-prev`, `walk-next` | step buttons |
| `walk-dots` | container for step-dot buttons |
| `exp-inventory`, `exp-schedule`, `exp-destruction`, `exp-print` | CSV export buttons + print |
| `builder-gate` | T&C gate panel |
| `gate-check` | gate consent checkbox |
| `gate-open` | gate submit button |
| `builder-app` | builder panel (starts `hidden`) |
| `bn-type` | node type `<select>` |
| `bn-label` | node label text input |
| `bn-cat` | edge category `<select>` |
| `bn-add` | add-node button |
| `builder-canvas` | builder SVG canvas (JS sets `viewBox="0 0 640 420"`, `role="application"`) |
| `canvas-wrap` | canvas wrapper div |
| `builder-status` | status line, `aria-live="polite"` |
| `bn-delete`, `bn-print`, `bn-xls`, `bn-save`, `bn-wipe` | action buttons |
| `bn-load` | file input (`accept="application/json"`, hidden inside a label styled as a button) |
| `builder-print-sheet` | print-only inventory section |

### Canvas implementation

Plain inline SVG built with `document.createElementNS`. No `<canvas>` element, no SVG library, no framework. State lives in closure variables inside `builder.js`.

### Render functions and event wiring (builder.js)

- `shapeFor(id, def)`: returns a `<g class="node [selected]" data-node="{id}" tabindex="0" role="button" aria-label="{type}: {label}" transform="translate(x,y)">` containing (1) an invisible tap halo (`class="hit"`, `fill="transparent"`), (2) the visible shape (`class="shape"`), (3) a `<text class="node-label" y="40" text-anchor="middle">`.
- `redraw()`: clears the SVG, draws edges first, then nodes.
- `svgPoint(evt)`: maps pointer coordinates to the 640x420 viewBox, clamped to x in [40,600], y in [40,380].
- `addNode(pt)`: creates id `"n" + (++seq)` with `{type, x, y, label}` from `bn-type`/`bn-label`; falls back to the `untitled` string.
- `activateNode(id)`: toggles selection; a second distinct tap creates `{a: selected, b: id, cat: bn-cat.value}` unless that pair already exists in either direction.
- Events: `pointerdown` on the SVG (node tap selects/connects, empty-canvas tap adds a node); `keydown` on the SVG (Enter or Space on a `[data-node]` activates it, focus restored to the redrawn node); `beforeunload` guard when dirty; gate click; per-button clicks for add, delete, wipe (with `window.confirm`), save, load, print, xls.
- State store: `nodes` (object keyed by id), `edges` (array), `seq` (integer counter), `selected` (id or null), `dirty` (boolean). Gate state: `sessionStorage["dm-gate-ok"] === "1"`.

### Globals the scripts expose

- `window.LANG`: `"en"` or `"fr"`.
- `window.T`: `{sim, walk, builder, exports}`; top-level keys identical in both languages.
- `window.RULES`: `{en, fr}`, five record categories each.
- `window.CHIPS`: `{en, fr}`, nine statute chips each.
- `window.WALK_NODES`: ten fixed nodes (see section 4). `window.WALK_STEP_EDGES`: eight per-step edge arrays.

## 3. Node data structure

Builder node (keyed in `nodes` by id `"n" + seq`):

```
{ type, x, y, label }
```

| Field | Type | Notes |
|---|---|---|
| `type` | string | one of `collection`, `system`, `thirdparty`, `destruction` |
| `x`, `y` | number | viewBox coordinates, clamped to x 40-600, y 40-380 |
| `label` | string | user text; defaults to the `untitled` string when empty |

Shapes per type: `collection` = circle r24; `system` = rect 104x48 rx8; `thirdparty` = diamond polygon `0,-27 31,0 0,27 -31,0`; `destruction` = dashed circle (dasharray 5 4) with an X in `#b3401f`. Each node carries an invisible tap halo matching its type (rect for system, polygon for thirdparty, circle otherwise). Label is drawn 40 units below center.

Walkthrough node catalogue (`window.WALK_NODES`): same fields plus fixed ids and coordinates:

| id | type | x | y | EN label |
|---|---|---|---|---|
| web | collection | 80 | 80 | Website checkout |
| pos | collection | 80 | 200 | In-store POS |
| news | collection | 80 | 320 | Newsletter form |
| orders | system | 310 | 80 | Order database |
| acct | system | 310 | 200 | Accountant spreadsheet |
| email | system | 310 | 320 | Email platform |
| proc | thirdparty | 545 | 80 | Payment processor |
| deliv | thirdparty | 545 | 200 | Delivery company |
| backup | system | 545 | 320 | Nightly backups |
| destr | destruction | 310 | 430 | Secure destruction |

Labels come from `window.T.walk.nl_*` and differ in French.

## 4. Edge data structure

Builder edge:

```
{ a, b, cat }
```

| Field | Type | Notes |
|---|---|---|
| `a`, `b` | string | node ids; `a` is the node selected first |
| `cat` | string | one of `contact`, `payment`, `marketing` (value of `bn-cat` at connect time) |

Rendered as a straight `<path class="edge {cat}">` from 28 units out of node A toward 32 units short of node B. Duplicate pairs (either direction) are rejected.

Walkthrough edges: `[from, to, cat]` triples in `window.WALK_STEP_EDGES`, built up cumulatively over 8 steps; rendered as cubic bezier paths with class `edge {cat} draw` on the current step.

Edge category taxonomy (legend): `contact` = contact/identity data, solid line; `payment` = payment data, dashed line; `marketing` = marketing/consent data, dotted line. Category meaning lives in shape plus line pattern plus label, never color alone.

### Other taxonomies

- Simulator record categories (5): `employee`, `customer`, `marketing`, `payment`, `accesslog`. Each RULES entry carries: `name`, `collected`, `purpose`, `range`, `basis` (array of chip ids), `caveats` (array of strings), `destroy`, `backup`.
- Statute chips (9): `law25-23`, `law25-consent`, `law25-access`, `pipeda45`, `ccq-2925`, `cra-6`, `casl`, `pci`, `cn-esst`. Each chip carries: `label`, `text`, `link` (or null), `linkText` (or null).

## 5. Exporter format

### SpreadsheetML `.xls` exporter (builder.js, `bn-xls` click handler)

Module: `builder.js` (anonymous IIFE, no library). Helpers `xlsCell(v, style)` and `xlsSheet(name, headers, rows)`.

- File: `data-map-inventory.xls`, MIME `application/vnd.ms-excel;charset=utf-8`, UTF-8 BOM prefix.
- Sheet "Nodes" (EN) / "Nœuds" (FR). Rows in order: `[checkpointDisclaimer]`, `[""]`, header, then one row per node.
  - EN header: `Label`, `Type`. FR header: `Étiquette`, `Type`.
  - Node row: `[label, optionText(type)]` where `optionText` resolves the `bn-type` select label (EN: "Collection point", "System", "Third party", "Secure destruction").
- Sheet "Connections" (EN) / "Liens" (FR). Rows: header, then one row per edge.
  - EN header: `From`, `To`, `Category`. FR header: `De`, `Vers`, `Catégorie`.
  - Edge row: `[label(a), label(b), optionText(cat)]` where `optionText` resolves the `bn-cat` select label (EN: "Contact / identity", "Payment", "Marketing / consent").
- Header style `h`: bold, fill `#EFE9DA`.
- The disclaimer row is the legal framing (`T.checkpointDisclaimer`).

Field mapping: builder node `{type, x, y, label}` maps to `[label, typeName]`; coordinates are NOT exported. Builder edge `{a, b, cat}` maps to `[label(a), label(b), catName]`; node ids are NOT exported.

### CSV export pack (export.js)

- `cafe-nord-inventory.csv`: 3 framing rows + blank, header `node_id,type,label,status`, one row per `window.WALK_NODES` entry as `[id, type, label, "draft"]`.
- `retention-schedule.csv`: framing rows, header `record_category,typical_range,legal_basis,key_caveat`, one row per RULES entry: `[name, range, basisLabels.join("; "), caveats[0]]`.
- `destruction-log.csv`: framing rows, header `date,system_or_location,records_destroyed,method,verified_by`, plus two example rows (`YYYY-MM-DD`, example system, empty, example method, empty).
- All CSVs are RFC-4180 quoted, CRLF line endings, BOM prefix, downloaded via Blob.

### JSON checkpoint (builder.js)

- `bn-save`: downloads `data-map-checkpoint.json` with `{tool: "data-map-checkpoint", version: 1, exportedAt, disclaimer, nodes, edges}`; full node/edge state including coordinates.
- `bn-load`: file input reading `application/json`; requires `data.nodes`, restores `nodes` and `edges` (default `[]`), sets `seq` to the node count.

## 6. Template cross-check

Reference file: `~/workspace/your_files/Data-Inventory-Template.xlsx` (SHA-256 `d2615a38d1061b2b038d696102f74fc4429a6eb37c05f428c7025658dc94909a`).

Sheets: `INSTRUCTIONS`, `TEMPLATE - Systems`, `TEMPLATE - Data flows`, `EXAMPLE 1 - Cafe Nord`, `EXAMPLE 2 - SaaS startup`, `EXAMPLE 3 - Health clinic`.

- Systems template header (row 2): `System / application name`, `Type`, `Data categories`, `Purposes of use`, `Lawful basis`, `Retention period`, `Storage location`, `Owner / department`, `Notes` (9 columns).
- Data flows template header (row 2): `From (system)`, `To (system)`, `Data categories transferred`, `Purpose of transfer`, `Cross-border?`, `Destination`, `Safeguards`, `Notes` (8 columns).
- Type dropdown: `Collection point, Internal system, Third party, Destruction / disposal`. Lawful basis dropdown: `Consent, Contract, Legal obligation, Legitimate interest, Other`. Storage location dropdown: `Quebec, Canada, United States, EU, Other / unknown`. Cross-border: `Yes, No`.

Mismatches against the frozen guide exporter:

1. The template's INSTRUCTIONS say to "upload it to the data mapping guide on movahedi.ca to generate a visual map". The frozen guide has no Excel upload: the only loader is `bn-load`, which accepts JSON checkpoints only (`accept="application/json"`). The promised upload feature does not exist in the frozen guide; it is a later-phase item.
2. Systems template has 9 columns; the exporter Nodes sheet has 2 (`Label`, `Type`).
3. Data flows template has 8 columns; the exporter Connections sheet has 3 (`From`, `To`, `Category`).
4. Type taxonomy mismatch: template uses `Internal system` where the guide uses `System`; `Destruction / disposal` vs `Secure destruction`. Case and wording differ on two of four values.
5. The template has no edge-category column at all; the guide requires one of the three fixed categories (`contact`, `payment`, `marketing`) per edge. The template's `Data categories transferred` is free text and does not map to it.
6. The template's `Lawful basis`, `Retention period`, `Storage location`, `Cross-border?`, `Destination`, `Safeguards` columns have no counterpart anywhere in the guide's node or edge model.

## 7. Keyboard, zoom, pan, fullscreen, print behavior

- Walkthrough SVG: `tabindex="0"`; ArrowRight / ArrowLeft move steps; prev/next buttons; step-dot buttons (`aria-label="Step N"`, `aria-current="step"` on the active one); caption has `aria-live="polite"`.
- Builder nodes: each node `<g>` is `tabindex="0"`, `role="button"`, with an `aria-label` of `type: label`. Enter or Space activates (select, or connect to the previously selected node); focus is restored to the redrawn node after each activation. Status updates go to `#builder-status` (`aria-live="polite"`).
- Simulator: Escape closes an open statute-chip note and resets chip `aria-expanded`.
- Builder: `beforeunload` guard when the canvas is dirty and non-empty; wipe asks `window.confirm`.
- Zoom: none. Pan: none. Fullscreen: none.
- Print: `#builder-print-sheet` renders the SVG clone plus nodes and connections tables (headers from `T.xlsNodeH`/`T.xlsEdgeH`) with the legal framing; `document.documentElement` gets class `printing-builder` during print (removed on `afterprint`); the shipped CSS has an `@media print` block (4 references to `.printing-builder`). The walkthrough `exp-print` button calls `window.print()` directly.

## 8. Freeze declaration

after this snapshot, no DOM or JS refactors of the guide without a spec version bump and retraining; the executor validates the snapshot hash at load and refuses to run against a changed guide

Validation target: the SHA-256 hashes of the two Tier A files in section 1. The executor must compare at load and refuse to run on any mismatch. The Tier B files are the editable working copies; any change to them must be re-shipped through `build_astro.py` into Tier A, which is itself a spec version bump.

Spec version: 1.0 (this snapshot, 2026-10-04).
