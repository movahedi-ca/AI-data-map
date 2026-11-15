# MANIFEST-ADAPTER-CONTRACT.md - dbt manifest adapter for the spreadsheet import path

Status: contract for gate G-MANIFEST (dbt next-steps playbook V4, TASK-015).
Version: 1.0, 2026-11-15.
Scope: this document defines the adapter. It is not an implementation. The implementation task (TASK-016) builds to this contract and to no other projection. The proof task (TASK-017) tests every numbered rule in this contract.

Companion evidence: EVD-014 (TASK-014 inspection of this repo at head 3cb30eeeb17fec053b2e81d64795f2412243cdd1) and EVD-015 in the ops records of the dbt next-steps program.

## 1. Purpose

The import path in this repo reads spreadsheets and builds a data map on the canvas. It has no dbt manifest handling (EVD-014, content search at the head named above). This contract defines a bounded adapter that accepts one dbt manifest file, held locally by the visitor, projects it to a documented node and edge set, ties it to a published release of the dbt privacy inventory, and renders that projection on the existing canvas through the existing `window.DMImport.applyState` seam.

The adapter renders a projection. It never renders the whole manifest. Section 6 lists what crosses into the projection. Everything else in the manifest stays out.

## 2. Definitions

- Manifest: a dbt `manifest.json` file produced by a dbt build or compile run.
- Projection: the Stage A output defined in section 6. Shape-compatible with `public_graph/v1`, the public graph format published with each dbt release.
- Release: one published dbt release, named by a release ID of the form `rel-<UTC timestamp>Z`, for example `rel-2026-11-07T13-50-09Z`.
- Pointer: the public file `https://movahedi.ca/dbt/releases/current.json`, which names the current release ID and the sha256 of that release's public descriptor.
- Index: the public file `https://movahedi.ca/dbt/releases/index.json`, which lists every published release ID.
- Descriptor: the public file `release.json` inside one release folder on movahedi.ca. It records the release ID, the source SHA, the engine distribution and version, and the sha256 and byte size of the release's `public_graph.json`.
- Canvas state: the frozen guide state `{nodes: {id: {type, x, y, label}}, edges: [{a, b, cat}], seq}` consumed by `DMImport.applyState`.

## 3. Accepted input

A-1. The adapter accepts exactly one file per import: a dbt manifest.
A-2. The file name must end in `.json`, case-insensitive. The file picker accept list gains `.json` for this path. Extension alone never proves a manifest; section 4 content checks decide.
A-3. Accepted manifest schema version: exactly one value. `metadata.dbt_schema_version` must equal `https://schemas.getdbt.com/dbt/manifest/v12.json`. This is the schema emitted by the pinned engine, dbt-oss 2.0.11, verified against the staged release bundle of rel-2026-11-15T16-52-25Z in EVD-014 section 6. Any other schema version is rejected with UNSUPPORTED_SCHEMA_VERSION (section 11). No silent acceptance of other versions, and no partial support.
A-4. `metadata.dbt_version` is read for the release tie in section 9. It is not an acceptance gate on its own.
A-5. The adapter does not accept catalog.json, run_results.json, a public_graph.json, a zipped bundle, or a manifest pasted as text. One file, one format.

## 4. Detection and structural validation

Detection runs in the import Web Worker, next to the existing format detection in `web/import/worker/parse-core.js`. Existing spreadsheet detection and behaviour do not change.

D-1. A file whose name ends in `.json` enters the manifest branch. Spreadsheet files never enter it.
D-2. The branch reads the file as text and parses it as JSON. A parse failure is rejected with MALFORMED_JSON.
D-3. The parsed value must be a JSON object. Its `metadata` must be an object and its `nodes` must be an object. Anything else is rejected with NOT_A_MANIFEST.
D-4. `metadata.dbt_schema_version` is then checked against rule A-3.
D-5. Prototype pollution guard: the strings `__proto__`, `constructor`, and `prototype` are rejected wherever they appear as an object key at the top level of the manifest, as a key of `nodes` or `sources`, or as a key of any node record the projection reads. Rejection code: POLLUTION_KEY. This matches the standing security posture of this repo (tests/security/prototype-pollution.test.js) and the adapter must never merge manifest objects into existing objects; it builds fresh records field by field.
D-6. Every projected node record must carry a string `resource_type` and a string `name`. A record missing either is rejected with MALFORMED_NODE naming the node key. The adapter never guesses a missing field.
D-7. If a node record carries a `unique_id` field, it must equal its key in `nodes`. A mismatch is rejected with NODE_ID_MISMATCH.
D-8. Validation is fail-fast and whole-file. The first failed rule rejects the file with one named error. No partial projection is ever rendered.

## 5. Limits

Limits mirror the proven exporter limits of the dbt project (scripts/export_graph.py in the dbt-privacy-inventory repo: MAX_NODES 500, MAX_EDGES 2000, MAX_LABEL_CHARS 200 for name and description, MAX_TAG_CHARS 200 per tag, MAX_TAGS 20 per node, MAX_DEPTH 10), plus a file size limit the current import path does not have. Where the existing tool is tighter, the tighter limit wins; the existing tool has no tighter numeric limit for this path, only its 60 second worker timeout, which still applies.

| ID | Limit | Value | Checked when | Breach |
|---|---|---|---|---|
| L-1 | File size | 10 MiB (10,485,760 bytes) | Before parsing | Reject, FILE_TOO_LARGE |
| L-2 | Projected node count | 500 | After projection | Reject, TOO_MANY_NODES |
| L-3 | Projected edge count | 2000 | After edge derivation and dedupe | Reject, TOO_MANY_EDGES |
| L-4 | Node name length | 200 characters | During projection | Reject, OVERSIZED_NAME |
| L-5 | Node description length | 200 characters | During projection | Reject, OVERSIZED_DESCRIPTION |
| L-6 | Tag length, per tag | 200 characters | During projection | Reject, OVERSIZED_TAG |
| L-7 | Tags per node | 20 | During projection | Reject, TOO_MANY_TAGS |
| L-8 | Longest dependency path in the projection | 10 nodes | After edge derivation | Reject, DEPTH_EXCEEDED |
| L-9 | Dependency cycle in the projection | None allowed | After edge derivation | Reject, CYCLE_DETECTED, message names the cycle path |
| L-10 | Worker time | 60 seconds | Existing worker client timeout | Existing timeout error |

Rules:
L-R1. Lengths count Unicode characters after trimming surrounding whitespace, matching the exporter's checked_text behaviour. Nothing is ever truncated silently. A breach rejects the whole file, as the exporter fails the whole export.
L-R2. Limits L-2 and L-3 count the projection, not the raw manifest. A manifest with 900 nodes of which 400 project is inside L-2. A manifest whose projection holds 501 nodes breaches L-2 no matter how it is laid out.
L-R3. The reference manifest of rel-2026-11-15T16-52-25Z is 638,969 bytes, about 6 percent of L-1. The limit is headroom, not a target.

## 6. Stage A: the projection

The projection is computed from `manifest.nodes` and nothing else. It mirrors the dbt project's exporter exactly, so the adapter's projection of a published release equals that release's public graph. EVD-014 section 6 records the parity check on rel-2026-11-15T16-52-25Z: node set equal, edge set equal, 45 nodes, 55 edges.

P-1. Node inclusion: a `nodes` entry is projected if and only if its `resource_type` is one of `model`, `seed`, `snapshot`, `test`.
P-2. Node exclusion: every other resource type found in `nodes` is excluded. The exclusion covers, without limitation, `analysis`, `operation`, `hook`, `rpc`, and `sql_operation` entries if present.
P-3. Top-level sections never read: `sources` (see P-4), `macros`, `docs`, `unit_tests`, `semantic_models`, `saved_queries`, `exposures`, `metrics`, `functions`, `groups`, `selectors`, `group_map`, `disabled`, `parent_map`, and `child_map`. Edges derive from node records (P-7), never from parent_map or child_map, matching the exporter.
P-4. Sources: entries in `manifest.sources` do not render as nodes. This is exporter parity: the published public graph holds no source nodes. A dependency of a projected node on a source is a dropped edge under P-8 and is counted, never hidden.
P-5. Ephemeral models: a model whose `config.materialized` equals `ephemeral` is projected as a node exactly like any other model. There is no collapsing and no edge rewiring through it. Exporter parity: the exporter does not filter on materialization. Dependents keep their direct edges to the ephemeral node.
P-6. Projected node record, the complete allowlist of fields that cross Stage A: `id` (the `nodes` key), `name`, `type` (the `resource_type` value), `description` (the node `description`, or the empty string when absent), `tags` (the node `tags` list, sorted ascending, or the empty list when absent), `depends_on` (the filtered parent list from P-7). No other manifest field crosses. In particular these never cross: compiled or raw SQL, database, schema, alias, file paths, checksums, environment values, metadata contents beyond section 9, and column definitions.
P-7. Edge derivation: for each projected node, read `depends_on.nodes` (a list of node IDs). A parent ID that is itself projected and is not the node itself becomes a candidate edge `{from: parent ID, to: node ID}`. `depends_on.macros` never creates edges. `depends_on.nodes_with_ref_location` is ignored; in schema v12 it duplicates `depends_on.nodes`.
P-8. Dropped edges: a candidate parent ID that is not in the projected set, or that equals the node itself, produces no edge. Each such dependency entry increments a dropped-edge count. The count is reported to the visitor in the review step and returned in the adapter result. Dropped edges are a reported fact, never a silent loss and never an error.
P-9. Dedupe and order: identical (from, to) pairs are emitted once. The node list is sorted ascending by `id`. The edge list is sorted ascending by (from, to). `depends_on` lists are sorted ascending. Output order is fully deterministic for a given manifest.
P-10. Stage A output shape: `{schema: "public_graph/v1", nodes: [...], edges: [...], counts: {nodes: N, edges: M}}`, with counts equal to the array lengths.
P-11. Canonical form: the Stage A output serialized as JSON with keys sorted, 2-space indent, non-ASCII characters escaped as \uXXXX (the Python json default the exporter writes), and no trailing newline, is byte-equal to the exporter's public_graph.json for the same manifest. Section 9 depends on this.

## 7. Stage B: canvas mapping

Stage B turns the Stage A projection into canvas state for `DMImport.applyState`. It runs on the main thread in the import UI, after the visitor confirms the review step.

C-1. Canvas node IDs: `n1` to `nN`, assigned in the Stage A sorted node order, no gaps. This matches the state builder convention in web/import/engine/state-builder.js.
C-2. Canvas label: the node `name`. When two or more projected nodes share one name, each colliding label becomes `name (unique_id)` so every canvas label stays unique and traceable. Non-colliding labels are the bare name.
C-3. Canvas type mapping, total and deterministic: `seed` maps to `collection`; `model`, `snapshot`, and `test` map to `system`. No projected node maps to `thirdparty` or `destruction`; a dbt manifest carries no fact that would justify either. These are layout types in the guide's vocabulary, not claims about the dbt node.
C-4. Layout: positions come from the existing layout rules of the state builder (collection column x 80, system column x 310, vertical spread y 80 to 320), clamped to x 40 to 600 and y 40 to 380. Layout is cosmetic. Set equality in TASK-017 is judged on node IDs, labels, types, and edge endpoints, not on pixels.
C-5. Canvas edges: one canvas edge per Stage A edge, endpoints translated through the C-1 ID assignment. No edge is added, merged, or removed in Stage B.
C-6. Edge category: a dbt manifest carries no edge category, and the canvas state requires one per edge from the set `contact`, `payment`, `marketing`. The adapter never invents a category per edge. Before building, the review step asks the visitor for one category for the whole import, with the same three choices the spreadsheet path offers per flow. The build button stays disabled until the visitor picks one. Every canvas edge then carries that one visitor-chosen category, and the review step states plainly that the category is the visitor's choice for the whole file, not a fact from the manifest.
C-7. Apply: the finished state is applied through `window.DMImport.applyState({nodes, edges, seq})` with `seq` equal to the projected node count, exactly as the spreadsheet path applies its state. If the hook is absent, nothing renders and the UI reports that the map could not be placed.
C-8. Review step content for a manifest import, shown before any build: file name, manifest schema version, dbt version, project name, the named release and its tie result (section 9), projected node count split by resource type, projected edge count, dropped-edge count, and the category pick from C-6. The sheet picker and column mapping steps of the spreadsheet path are skipped for manifests; there are no sheets and no columns to map.

## 8. Privacy rules

V-1. Browser-local only. The manifest file is read on the visitor's device, parsed in the Web Worker, and projected in the browser. The file and its contents are never uploaded, in whole or in part, to any server.
V-2. No network call carries file content. No fetch, XMLHttpRequest, WebSocket, beacon, or form submission may include the file bytes, any manifest field, the projection, or any hash of the file, except the projection hash comparison in V-3, which is computed locally and never sent.
V-3. The only network requests the adapter may make are same-origin or movahedi.ca GET requests for public release records, naming only a release ID in the path: `releases/current.json`, `releases/index.json`, and `releases/<release_id>/release.json`. These are the tie checks of section 9. They send no file content and no visitor data.
V-4. Nothing is persisted. The adapter writes no localStorage, sessionStorage, IndexedDB, cookie, or cache entry derived from the manifest or the projection. Closing or resetting the import clears the projection from memory, as the spreadsheet path clears its state.
V-5. Labels and descriptions render as text, never as HTML, matching the existing import UI practice of textContent. Manifest strings are untrusted input.
V-6. The restricted manifest itself is a private artifact of the dbt project (TASK-036 class C-11 in the dbt next-steps program). The adapter works on a manifest the visitor already holds locally. The adapter never fetches a manifest from anywhere, and no part of this design publishes one.

## 9. Release tie rules

A raw dbt manifest does not name a release. Its metadata holds no release_id (verified in EVD-014 section 6: the metadata keys are the schema version, dbt version, timestamps, invocation_id, project name and ID, adapter type, and quoting). The bundle that a release is built from pairs the manifest with a bundle release record whose invocation_id equals the manifest metadata.invocation_id and whose files map holds the manifest sha256. The public side can verify a manifest only through the published projection. The tie rules below are therefore the strongest tie the public pointer can verify, and they are mandatory.

T-1. The visitor names a release ID at import time, typed or picked from the index list. The adapter fetches the index (V-3) and requires the named release ID to appear in it. An unlisted release ID is rejected with UNKNOWN_RELEASE.
T-2. The adapter fetches the descriptor for the named release and requires descriptor.release_id to equal the named release ID. A mismatch is rejected with RELEASE_MISMATCH.
T-3. Content binding: the adapter serializes its Stage A projection in the canonical form of P-11, computes its SHA-256 locally, and requires it to equal the descriptor's public_assets entry for public_graph.json (sha256; the byte length is also compared). A mismatch is rejected with RELEASE_MISMATCH and nothing renders. Equal hashes prove the local manifest projects to exactly the graph that release published.
T-4. Metadata consistency: manifest metadata.dbt_version must equal the descriptor's engine.version, and metadata.dbt_schema_version must satisfy A-3. A mismatch is rejected with RELEASE_MISMATCH.
T-5. Current or historical: a named release that is in the index but is not the pointer's current release still verifies under T-1 to T-4. The review step states whether the named release is the current one, by comparing with the pointer, and says so plainly when it is not.
T-6. Fail closed: if any tie fetch fails, times out, or returns unusable data, the import is rejected with UNVERIFIED_RELEASE. There is no offline mode, no skip option, and no render without a verified tie.
T-7. The tie binds the manifest to the release. It says nothing about the visitor's right to hold the manifest, and the adapter makes no claim about provenance beyond the hash equality in T-3.

Worked reference values (from EVD-014 section 6, for TASK-017 fixtures):
- rel-2026-11-15T16-52-25Z staged manifest: 45 projected nodes (9 model, 4 seed, 32 test, 0 snapshot), 55 projected edges, 0 dropped edges, projection sha256 397fefbd0e9d604606207e69a93c9bb9e60f4fab8928b67eccc8340c001ad719.
- Live rel-2026-11-07T13-50-09Z: descriptor public_graph.json sha256 is the same 397fefbd value, because both releases publish the same demo graph. Its pointer release_manifest_sha256, d9388d8ad4ad5d25aae9ac0ed4ca495e2206bf68a8025e0745510592bc8ffc1b, is the sha256 of the descriptor bytes themselves.

## 10. Error catalogue

Every rejection is a plain-language message in the import UI status line, in the pattern of the existing parse errors, plus the machine code below for tests. After any rejection the import returns to the file step, the file input is cleared, and the visitor can pick another file. No rejection leaves partial state on the canvas. Existing canvas content is untouched by a failed manifest import.

| Code | Trigger rule | Recovery |
|---|---|---|
| FILE_TOO_LARGE | L-1 | Pick a smaller file |
| MALFORMED_JSON | D-2 | Fix or re-export the file |
| NOT_A_MANIFEST | D-3 | Pick a dbt manifest.json |
| UNSUPPORTED_SCHEMA_VERSION | A-3, D-4 | Rebuild with the pinned dbt version |
| POLLUTION_KEY | D-5 | Fix the file; never accepted |
| MALFORMED_NODE | D-6 | Fix the file |
| NODE_ID_MISMATCH | D-7 | Fix the file |
| OVERSIZED_NAME | L-4 | Shorten the name in dbt, rebuild |
| OVERSIZED_DESCRIPTION | L-5 | Shorten the description, rebuild |
| OVERSIZED_TAG | L-6 | Shorten the tag, rebuild |
| TOO_MANY_TAGS | L-7 | Reduce tags, rebuild |
| TOO_MANY_NODES | L-2 | Reduce project scope |
| TOO_MANY_EDGES | L-3 | Reduce project scope |
| CYCLE_DETECTED | L-9 | Fix the cycle in dbt |
| DEPTH_EXCEEDED | L-8 | Flatten the dependency chain |
| UNKNOWN_RELEASE | T-1 | Name a published release |
| RELEASE_MISMATCH | T-2, T-3, T-4 | Name the release this manifest belongs to |
| UNVERIFIED_RELEASE | T-6 | Retry when the release records are reachable |

## 11. Non-goals and exclusions

- No implementation in the task that produced this contract (TASK-015). No import code changes.
- No change to any existing spreadsheet format, kind, error, or behaviour. The adapter is additive: a new detection branch, a new projection module, a new review branch.
- No server component, no MCP change, no upload path, no analytics on manifest content.
- No rendering of sources, macros, tests of unit type, exposures, metrics, or semantic models. The projection in section 6 is the whole renderable set.
- No support for manifest schema versions other than v12 until a later contract revision adds one with its own verification evidence.

## 12. Testability map (for TASK-016 tests and the TASK-017 proof)

Every rule above is written to be testable. Minimum assertions:

1. A-3, D-4: a v11 or v13 schema fixture is rejected with UNSUPPORTED_SCHEMA_VERSION; the v12 reference fixture is accepted.
2. D-2, D-3: truncated JSON gives MALFORMED_JSON; a JSON object without nodes gives NOT_A_MANIFEST; a spreadsheet fixture still imports exactly as before (regression).
3. D-5: a fixture with a `__proto__` node key gives POLLUTION_KEY and Object.prototype is unchanged after the attempt.
4. L-1: a file of 10,485,761 bytes gives FILE_TOO_LARGE; a valid manifest padded with trailing whitespace to exactly 10,485,760 bytes is accepted.
5. L-2, L-3: generated fixtures at 501 projected nodes and at 2001 projected edges give TOO_MANY_NODES and TOO_MANY_EDGES; fixtures at exactly 500 and 2000 pass the limit checks.
6. L-4 to L-7: one fixture per limit, at limit plus one, gives the named code; at-limit fixtures pass.
7. L-8, L-9: an 11-node dependency chain gives DEPTH_EXCEEDED; a 2-node cycle gives CYCLE_DETECTED naming both nodes.
8. P-1, P-2: a fixture holding one node of each resource type named in P-1 and P-2 projects exactly the four P-1 types.
9. P-4, P-8: a fixture with one source and one model depending on it projects one node, zero edges, dropped-edge count 1.
10. P-5: a fixture with an ephemeral model between two models projects three nodes and both direct edges, with no rewired edge skipping the ephemeral node.
11. P-6: the projected record of a rich node fixture holds exactly the six allowlisted fields.
12. P-9, P-10, P-11: the staged rel-2026-11-15T16-52-25Z manifest projects to 45 nodes and 55 edges, and its canonical serialization hashes to 397fefbd0e9d604606207e69a93c9bb9e60f4fab8928b67eccc8340c001ad719.
13. C-1 to C-3: canvas IDs are n1 to nN in sorted order; a duplicate-name fixture produces the C-2 suffixed labels; seed nodes carry type collection and all others system.
14. C-6: with no category picked, the build control is disabled; after one pick, every canvas edge carries that category.
15. T-1 to T-6: the reference manifest against its own release verifies; against a different indexed release it gives RELEASE_MISMATCH; an unlisted ID gives UNKNOWN_RELEASE; a blocked descriptor fetch gives UNVERIFIED_RELEASE.
16. V-1 to V-4: a network log of a full import session shows only the V-3 GET requests, none carrying file content; storage holds no adapter entries after the import.
17. Section 10: every rejection returns the UI to the file step with the prior canvas content unchanged.

## 13. Decisions recorded for G-MANIFEST

These choices are inside this contract and are what G-MANIFEST approves:

1. Sources do not render (P-4). Exporter parity over lineage completeness. Dropped source edges are counted and shown.
2. Ephemeral models render as ordinary nodes (P-5). Exporter parity; no rewiring.
3. Tests render as nodes (P-1). The published graph includes them: 32 of its 45 nodes are tests. Excluding them would break parity with the published release.
4. One visitor-chosen category for all edges (C-6). The manifest carries no category; per-edge invention is not allowed, and per-edge confirmation of dozens of edges is not usable.
5. Fail-closed release tie (T-6). No verified tie, no render.
6. Whole-file rejection on every limit (section 5). No truncation, no partial render, matching exporter failure behaviour.

## 14. Related system documentation

- dbt repository backend documentation: `docs/BACKEND.md` in the
  `movahedi-ca/dbt-privacy-inventory` repository. It records the system
  map, file map, invariants, and change protocol for the nightly build
  and release system that publishes the releases this contract ties to.
- Site backend documentation: `docs/dbt-backend.md` in the
  `movahedi-ca/movahedi-ca` repository. It records the site side of the
  same release system.
- Editors of this contract must read those documents before changing
  the release tie, the projection, or the public graph format. A change
  on either side must keep the shared invariants in section 8 and
  section 9 of this contract consistent with the dbt system documents.
