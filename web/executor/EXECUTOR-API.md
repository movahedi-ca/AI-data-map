# Executor API (Phase 7 handoff)

The in-browser System-1 executor lives in `web/executor/js/`. It executes a
recipe, one model step at a time, then opens a human review loop and exports
a draft Excel workbook. Everything runs client side; nothing is sent anywhere.

Load order (all UMD): `net-guard.js`, `s1tokenize.js`, `s1util.js`, `menu.js`,
`apply.js`, `narrate.js`, `templates.js`, `review.js`, `exporter.js`,
`i18n.js`, `executor.js`, `ui.js`.

## Runtime hooks: `window.__s1executor`

`executor.js` attaches the same `hooks` object to `window.__s1executor`
(test/QA handle) and exposes it as `S1Executor.hooks`. The three hooks that
matter for Phase 7:

### `state()`

Returns the live session snapshot, or `null` when no session is running.

```json
{
  "session_id": "s1-a3f9c21be04d",
  "recipe_id": "t-2-services-qc-all-01",
  "item_index": 7,
  "items": 12,
  "nodes": { "n1": { "node_id": "n1", "label": "Client intake form", "type": "collection", "x": 80, "y": 80 } },
  "edges": [ { "a": "n1", "b": "n2", "cat": "contact" } ],
  "annotations": [ { "kind": "retention", "node_id": "n2", "payload": { "record_type": "Quebec tax books and records", "range_min_years": 6, "range_max_years": 7, "statute": "...", "as_of": "2026-10-04" } } ],
  "terminated": false,
  "abort_reason": null,
  "flag_open": false,
  "state_hash": "9f2c...",
  "steps": 14,
  "done": false
}
```

Valid any time after `start(recipe)`. `item_index` is the current recipe
item, `done` turns true when a terminal step is applied. `state_hash` is
the guide-state hash (idempotency and integrity checks).

### `trace()`

Returns the full run trace, valid after any `start(recipe)` (even before
the first step, when `steps` is empty):

```json
{
  "session_id": "s1-a3f9c21be04d",
  "recipe_id": "t-2-services-qc-all-01",
  "encoding_version": "1.0.0",
  "steps": [
    { "step_index": 0, "item_index": 0, "action_name": "add_collection_point",
      "params": { "node_id": "n1", "label": "Client intake form", "x": 80, "y": 80 },
      "menu_index": 3, "menu_names": ["add_node", "add_collection_point", "connect", "set_retention"],
      "score": 0.94, "from_model": true, "terminal": null }
  ],
  "done_heads": { "0": true, "1": true, "2": false }
}
```

Each step records what the model picked (`action_name`, the winning
`menu_index` into that step's `menu_names`, `score`, `from_model`). The
model is never bypassed: the applied action always comes from the argmax.
`done_heads` maps recipe item index to its completion predicate.

### `reset()`

Tears the session down (`executor`, `recipe`, `steps`, session id all
cleared). Valid any time; safe to call with no session running. After
`reset()`, `state()` returns `null`.

Sibling hooks used by the UI: `start(recipe)`, `stepOnce()`, `runAll()`,
`abort(reason, lang)`, `clearFlagAndContinue()`,
`recordConfirmation(node_id, note)`, `applyCorrection(op)`, `setLang(lang)`.

## Recipe JSON format

A recipe is a plain JSON object. Schema: `specs/recipe-schema.json`;
vocabulary: `specs/RECIPE-VOCABULARY.md`; frozen sample:
`specs/SAMPLE-RECIPE.json`.

Minimal example (the three-item core):

```json
{
  "recipe_id": "cafe-nord-sample-01",
  "schema_version": "1.0.0",
  "name": "Cafe Nord sample: checkout form to Shopify to Klaviyo",
  "items": [
    { "intent": "add_collection_point", "params": { "node_id": "n1", "label": "Online checkout form", "x": 80, "y": 80 } },
    { "intent": "add_node", "params": { "node_id": "n2", "label": "Shopify", "type": "system", "x": 310, "y": 80 } },
    { "intent": "connect", "params": { "a": "n1", "b": "n2", "cat": "contact" } }
  ]
}
```

Fields: `recipe_id` (`^[A-Za-z0-9_-]+$`), `schema_version` (`1.0.x`,
executor 1.x), `name` (display only), `items` (non-empty ordered list of
`{intent, params}`). Authoring intents: `add_node`,
`add_collection_point`, `connect`, `set_field`, `set_retention`,
`run_check`, `export`, `confirm_node`, `flag_for_review`. Recovery intents
(`undo_last`, `skip_recipe_item`, `abort_session`) are executor-only;
recipes must not reference them and the executor rejects unknown intents.
Every mutating intent is idempotent; checks surface flags and never declare
a mapping compliant.

## 4-chip intake and template skeletons

`templates.js` implements the intake: four chips pick a recipe skeleton from
a fixed table with zero runtime tokens.

Chips and option lists (contract 7.1):

| chip    | options |
|---------|---------|
| size    | `1-10`, `11-50`, `51-200`, `200+` |
| sector  | `retail`, `services`, `health`, `tech`, `manufacturing`, `nonprofit` |
| region  | `quebec`, `canada`, `canada-us`, `international` |
| types   | `contact`, `contact-payment`, `contact-marketing`, `all` |

Lookup: `S1Templates.selectTemplate({size, sector, region, types})`
returns a deep copy of the matching skeleton, or `null` when the
combination is not authored (the UI names the nearest authored templates).
`S1Templates.authoredTemplates()` lists what exists; `validateChips`
checks the vector.

Three skeletons ship today:

1. `t-2-services-qc-all-01` ("Services firm, Quebec, contact plus payments
   plus marketing"): chips `11-50 | services | quebec | all`. Nodes n1
   (collection: "Client intake form"), n2 (system: "Microsoft 365"), n3
   (thirdparty: "Stripe"), n4 (thirdparty: "Mailchimp"); contact, payment,
   and marketing edges; tax-books retention (6 to 7 years, statute cited) on
   n2 and verify-only retention on n3 and n4.
2. `t-1-retail-qc-contact-payment-01` ("Small retailer, Quebec, contact plus
   payments"): chips `1-10 | retail | quebec | contact-payment`. Nodes n1
   (collection: "Online checkout form"), n2 (system: "Shopify"), n3
   (thirdparty: "Stripe"); contact and payment edges; tax-books retention on
   n2, verify-only on n3.
3. `t-3-tech-caus-contact-marketing-01` ("Tech firm, Canada and the US,
   contact plus marketing"): chips `51-200 | tech | canada-us |
   contact-marketing`. Nodes n1 (collection: "Signup form"), n2 (system:
   "HubSpot"), n3 (thirdparty: "Mailchimp"); contact and marketing edges;
   verify-only retention on n2 and n3; a `flag_for_review` on n3 for the
   cross-border transfer (the run pauses until the review pass clears it).

Every skeleton ends with `run_check` (all four checks: `label_coverage`,
`connectivity`, `retention_cited`, `edge_categories`) then `export`. The
full 384-template authoring against `vendor-kb.json` is Phase 7 work.

## `execute_mapping_workflow` contract proposal

For the Phase 7 chatbot + MCP plumbing. The chatbot authors recipes; it
never executes. The executor does the running.

### `start(recipe)` -> session ticket

```
start(recipe: RecipeJSON) -> { session_id: string, item_count: int }
```

Validates the recipe structurally (schema 1.0.x, non-empty items), opens a
session (`s1-` + 12 hex chars of `sha256(recipe_id + "\0" + Date.now())`),
and returns the ticket. The chatbot hands the ticket back to the user so a
later message can reference the session.

### `step()` -> one model step

```
step() -> { action: string, narration_en: string, narration_fr: string, done_heads: { [item_index]: bool } }
```

`action` is the applied action name (always the model argmax over that
step's menu, never scripted). `narration_en`/`narration_fr` come from
`narrate.js` (`S1Narrate.narrate(action, ctx, lang)`); FR strings stay in
`i18n.js`/`narrate.js`, never in the contract payload. `done_heads` is the
per-item completion map. When a step is terminal, the caller stops stepping
and moves to review.

### Review, correct, download, wipe

- Review entry: the review loop reads the checklist via
  `S1Review.deriveChecklist(executor)`; each row is
  `{ref, kind, label, detail, status}`. Rows covered by `confirm_node`
  recipe items start confirmed.
- Confirm: `recordConfirmation(node_id, note)` writes a contract 6.2
  confirmation record (`session_id, recipe_id, item_index, ref, label,
  note, by: "reviewer", at`).
- Correct: `applyCorrection(op)` applies `relabel`, `retype`, `remove_node`,
  `reconnect`, `remove_edge`, or `verify_only` out-of-band, returns
  `{op, before, after}`. Every correction is also appended as a JSONL line
  (`S1Review.correctionLine`) for future training; the correction log is
  never folded into the export, it downloads separately as
  `corrections.jsonl`.
- Download: `S1Exporter.buildDraftWorkbook({nodes, edges}, checklist,
  confirmations, lang)` returns SpreadsheetML 2003 XML (BOM-prefixed) with
  Nodes/Noeuds, Connections/Liens, Review/Revision, and Confirmations
  sheets, all draft-for-review labeled. The Review sheet always reflects the
  corrected state: after a fix, the checklist row is re-derived from the
  executor, and rows for removed artifacts render "removed during review"
  instead of stale detail.
- Wipe: `__s1executor.reset()` plus the UI clears its checklist,
  confirmations, and corrections buffers. One click, no leftovers.

### Chatbot delivery: recipe in, session out

1. The chatbot collects the four chips from the user (or accepts a full
   recipe JSON pasted in).
2. It calls `selectTemplate(chips)` for a skeleton, or accepts the pasted
   recipe after the structural check.
3. It calls `start(recipe)` and returns the ticket:
   `{ session_id, item_count }`.
4. The frontend drives `step()` in a loop, narrating each step, until a
   terminal step. Then it opens the review UI. Review, correction, Excel
   download, and wipe run as above.

No em dashes in any of this; EN is the contract language, FR strings live
in `i18n.js`.
