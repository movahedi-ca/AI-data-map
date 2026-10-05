# Recipe Vocabulary (Phase 0, v1.0.0)

The complete intent language shared by the chatbot (author), the MCP tool
`execute_mapping_workflow` (planner), the guide-driving tools (muscles), and
the System-1 model (reflexes). A recipe is an ordered list of intents; the
executor runs them one at a time against the frozen guide
(GUIDE-FREEZE.md, spec version 1.0).

Intent names, parameter names, and version strings are frozen. They must
match recipe-schema.json, token-schema.json, state-snapshot-schema.json,
and action-catalogue.json exactly.

## Conventions

- Node ids are explicit in the recipe: `"n1"`, `"n2"`, ... They assume a
  fresh builder canvas (seq starts at 0, so ids must arrive in ascending
  order with no gaps).
- All coordinates are viewBox units. The frozen guide clamps to
  x 40-600, y 40-380; recipes state coordinates inside that box.
- Every mutating intent is idempotent (see action-catalogue.json for the
  key mechanism). Replaying an intent is a no-op that returns the recorded
  result.
- Retention annotations live in the session layer, not in the guide DOM.
  The frozen guide node model `{type, x, y, label}` has no retention field,
  so `set_retention` writes to the session annotation store. Annotations
  appear in `run_check` reports; they are not part of the `.xls` export
  (the exporter only writes Label/Type and From/To/Category).
- "Verify" flags, never compliance verdicts: per the retention rule,
  no intent ever declares a mapping compliant. Checks surface flags.

## Intent catalogue

### add_node

Create one node on the canvas.

Parameters:
- `node_id` (string, required): must match `^n[1-9]\d*$` and must equal
  `"n" + (current guide seq + 1)`. No gaps, no reordering.
- `type` (string, required): one of `collection`, `system`, `thirdparty`,
  `destruction`.
- `x` (number, required): 40 to 600 inclusive.
- `y` (number, required): 40 to 380 inclusive.
- `label` (string, required): 1 to 200 characters.

Preconditions: canvas is fresh or the id continues the live
sequence; type is in the enum; coordinates in range; label non-empty.
The guide's `seq` counter is monotonic and never decrements, including
after undo.

Effects: guide seq increments; node `{type, x, y, label}` appears under
`node_id`; node is keyboard-focusable (`tabindex="0"`, `role="button"`).

Failure modes: id out of sequence or already taken (reject, plain
language); unknown type; coordinates out of range (reject, no silent
clamp); empty or overlong label.

### add_collection_point

Typed variant of `add_node` with `type` fixed to `collection`. Same
parameters minus `type`; same preconditions, effects, and failure modes.
Use this for collection points so recipes read as the business describes
them (forms, checkouts, POS terminals) rather than as raw type codes.

### connect

Draw an edge between two nodes.

Parameters:
- `a` (string, required): source node id (the node selected first).
- `b` (string, required): target node id.
- `cat` (string, required): one of `contact`, `payment`, `marketing`.

Preconditions: both nodes exist; `a` differs from `b`; the pair is not
already connected in either direction.

Effects: edge `{a, b, cat}` appended to the edges array.

Failure modes: unknown node id; self-loop; duplicate pair in either
direction (reject, the guide itself refuses these); unknown category.

### set_field

Edit one guide-model field on an existing node.

Parameters:
- `node_id` (string, required).
- `field` (string, required): one of `label`, `x`, `y`. Only
  guide-model fields are writable; there is no other field to set.
- `value` (string for `label`, number for `x`/`y`, required).

Preconditions: node exists; `x` in 40-600, `y` in 40-380; label 1-200
characters.

Effects: the field is updated in the guide state; the node is redrawn.

Failure modes: unknown node; unknown field name (reject, do not invent
fields); out-of-range coordinate (reject, no silent clamp); empty label.

### set_retention

Attach a retention range annotation to a node. This is the intent bound
by the hard retention rule (RETENTION-RULE.md).

Parameters:
- `node_id` (string, required).
- `record_type` (string, required): plain-language record category,
  e.g. "Quebec tax books and records".
- `range_min_years` (number, required unless `verify_only`): the
  statutory floor, positive.
- `range_max_years` (number, required unless `verify_only`): floor plus
  one year per the retention convention; must be greater than
  `range_min_years`. A single number is never accepted: the executor
  rejects any call that supplies only one bound.
- `statute` (string, required unless `verify_only`): the actual statute
  and section that sets the period, e.g. "Loi sur l'administration
  fiscale, RLRQ, c. A-6.002, ss. 34, 35.3". Minimum 8 characters; a
  bare act name with no section is rejected.
- `as_of` (string, required): date the citation was verified,
  format `YYYY-MM-DD`, not in the future.
- `anchor` (string, optional): the event the range is measured from,
  e.g. "after death", "duration of services", "after account closure".
  When present, the range is measured from the anchor event.
- `verify_only` (boolean, optional, default false): when true, no range
  is asserted and the annotation carries a "verify" flag instead. This
  is the only legal form for an entry that cannot cite a statute.

The statute parameter is validated against the normative matcher in
the "Statute validation" section below: it must name an act and a
section (pattern-matched), and Law 25 name variants are rejected as
the source of a number.

Preconditions: node exists; `range_min_years < range_max_years`;
`as_of` is a real calendar date.

Effects: annotation stored in the session layer under `node_id`,
replacing any existing retention annotation on that node; appears
in `run_check` output as the cited range or as a verify flag. When
`anchor` is present, the range is read as measured from the anchor.

Failure modes: single-number range (reject); missing or section-less
statute (reject, unless `verify_only`); missing or future `as_of`
(reject); Law 25 cited as the source of a number (reject: Law 25 sets
no retention periods, it only supplies the destroy-or-anonymize trigger).

### run_check

Run named checks over the current canvas and annotations. Non-mutating.

Parameters:
- `checks` (array of string, required, at least one, unique): subset of
  `label_coverage`, `connectivity`, `retention_cited`, `edge_categories`.

Check definitions:
- `label_coverage`: every node has a non-default label (the guide's
  `untitled` fallback counts as missing).
- `connectivity`: every `collection` node has at least one edge to a
  `system` node; every node except `destruction` participates in at
  least one edge.
- `retention_cited`: every `system` and `thirdparty` node carries a
  retention annotation with either a statute-cited range or a verify
  flag.
- `edge_categories`: every edge category is in the frozen taxonomy
  (true by construction; guards against tool-layer corruption).

Preconditions: none.

Effects: produces a check report: per-check pass/fail, per-node findings,
and verify flags. The report never contains a compliance verdict.

Failure modes: unknown check name (reject); empty checks array (reject).

### export

Trigger the guide's SpreadsheetML `.xls` export. Non-mutating.

Parameters:
- `format` (string, required): must be `xls`. This is the only exporter
  the frozen guide ships.

Preconditions: canvas has at least one node.

Effects: the guide downloads `data-map-inventory.xls` (sheets
"Nodes"/"Nœuds" and "Connections"/"Liens" per the freeze doc).

Failure modes: any format other than `xls` (reject, loudly: do not
fall back to CSV or JSON silently); empty canvas.

### confirm_node

Review-loop hook: mark a node as human-confirmed.

Parameters:
- `node_id` (string, required).
- `note` (string, optional): up to 500 characters.

Preconditions: node exists.

Effects: session records the confirmation with the current item index.
Does not touch the guide DOM.

Failure modes: unknown node.

### flag_for_review

Review-loop hook: raise an item for human attention. Usable both as a
recipe intent and as an executor recovery action.

Parameters:
- `node_id` (string, optional).
- `item_index` (integer, optional): the recipe item under review.
- `reason` (string, required): 1 to 500 characters.

Preconditions: at least one of `node_id` or `item_index` is present;
the referenced node/item exists.

Effects: session records the flag. While any flag is open, the
recipe is paused: `item_index` is frozen, and the valid-action set is
reduced to `undo_last` (if applicable), `abort_session`, and
`flag_for_review` (to add further flags). A flag is cleared by a human
out-of-band through the review UI, or by `undo_last` targeting the
`flag_for_review` action. On clear, the recipe resumes from the flagged
point.

Failure modes: neither target given; unknown node or item index.

## Recipe-level rules

1. Items execute in order, one at a time. An item that fails stops the
   recipe at that item (the failure is recorded; later items do not run).
   The failed item counts as the current item: the valid actions become
   `undo_last`, `skip_recipe_item` (skipping it resumes the recipe past
   the failure), `abort_session`, and `flag_for_review`.
2. Recovery actions (`undo_last`, `skip_recipe_item`, `abort_session`)
   are available at every step; see action-catalogue.json. `skip_recipe_item`
   may target only the current item: it marks the item skipped, advances
   `item_index` by one, and the recipe continues.
3. The valid-action menu at each step is a closed deterministic function
   of the current recipe item and session state: the current item's
   intent with its exact recipe params, plus `undo_last` (iff an applied,
   non-tombstoned mutating action exists), `skip_recipe_item` (current
   item only), `flag_for_review` (targets the current item by default),
   and `abort_session` (always). At most five entries.
4. The executor validates the recipe against recipe-schema.json before
   the first item runs. Schema violations abort with a plain-language
   error naming the item index and the violated rule.
5. Version rule: the executor loads only recipe versions its
   compatibility matrix allows. Anything else is rejected at load with
   a plain-language error, never executed partially.
6. Mutating is the default: an action without an explicit `"mutating":
   false` is mutating. The guide's `seq` counter is monotonic and never
   decrements, including after undo; undone node ids leave gaps, and a
   later recipe item whose id no longer matches the live sequence fails
   loudly instead of mis-assigning.

## Statute validation (normative)

Applied case-insensitively: the executor normalizes the `statute`
string to lowercase, then:

- Rejects it if it contains any Law 25 name variant as a substring:
  "law 25", "loi 25", "bill 64", "lprpsp",
  "modernisant des dispositions legislatives en matiere de protection des renseignements personnels",
  "renseignements personnels dans le secteur prive".
  Law 25 sets no retention periods, so it can never be the source of a number.
- Requires a section pattern match for non-`verify_only` entries:
  `s`/`ss`/`art`/`article`/`r`/`rule` followed by a number, or `§`
  followed by a number (e.g. "s. 230(4)(b)", "ss. 34, 35.3",
  "art. 23"). A bare act name with no section is rejected.

## Recovery intents

### undo_last

Reverse the most recent applied mutating action via its undo inverse.
No parameters. When scanning for the target, `undo_last` actions
themselves are skipped: a second consecutive `undo_last` undoes the
next-earlier mutating action, never the first undo. The undone action's
idempotency key moves to a tombstone set. There is no re-apply in
Phase 0; replaying an `undo_last` key returns the recorded undo
result as a no-op.

### skip_recipe_item

Mark the current recipe item skipped and continue past it.

Parameters:
- `item_index` (integer, required): must equal the current item index.
- `reason` (string, required): 1 to 200 characters.

Preconditions: the current item has not already completed
successfully. A failed item counts as current: skipping it resumes the
recipe past the failure.

Effects: the item is marked skipped, `item_index` advances by one,
and the recipe continues. Replaying returns the recorded skip marker.

### abort_session

Terminate the session immediately.

Parameters:
- `reason` (string, required): 1 to 500 characters.

Preconditions: none. Available in every state, including while a
review flag pause is open.

Effects: the session terminates; the snapshot is sealed
(`terminated: true`, `abort_reason` set, `item_index` left at the item
that was current). No further items execute. A terminated session is
never resumed.

## Reserved for later phases

Excel upload into the guide (the template promises it; the frozen guide
has no such loader), multi-language export sheets beyond EN/FR, and
batch/bulk intents. Recipes must not reference them; the executor
rejects unknown intents.
