# Teacher shard format (contract version 1.0.0)

The scripted teacher (Phase 4) emits labeled training steps as JSONL shards.
Each line is one labeled step: a tokenized state plus the valid-action menu
and the teacher's chosen menu entry. The training loader (`training/data.py`)
reads exactly this format.

## Line schema

```json
{
  "shard_format": "1.0.0",
  "recipe_id": "r-000123",
  "domain": "data-mapping",
  "step_index": 4,
  "input_ids": [0, 32, 33, 2, 96, 3, 4, 224, 225, 1],
  "fields": ["{}", "{\"label\":\"Intake form\",\"node_id\":\"n1\",\"type\":0,\"x\":80,\"y\":80}", "..."],
  "menu_actions": ["add_node", "connect", "export"],
  "gold_menu_index": 1
}
```

Field rules:

- `shard_format`: semver string, currently `"1.0.0"`. The loader rejects
  anything else loudly; it never guesses.
- `recipe_id`: string. Steps sharing a recipe id belong to one episode.
  Train/val splits are by recipe id, never by step.
- `domain`: string label. The loader never uses it as a model feature.
  It exists so eval can split in-domain from out-of-domain. Naming
  convention (set by the Phase 4 teacher track): in-domain recipes are
  `data-mapping/*`, out-of-domain recipes are `ood-*`. Eval matches on
  these prefixes and reports the two scores separately.

## Annotation anchors (union rule)

Annotation tokens anchor to a node via their `node_slot` field. The slot
space is the UNION of canvas nodes and annotation anchors: a flag anchor
may reference a not-yet-built node. Concretely, the teacher hit the case
where `flag_for_review` carries only `item_index` on an empty canvas, and
its documented encoding rule anchors the annotation on the first canvas
node, or on the next-seq id (`"n" + (seq + 1)`) when the canvas is empty.
Slot indices are therefore assigned over canvas node ids plus anchor ids
together, in the same node-id sort order; an annotation's `node_slot` may
validly point at a slot with no corresponding node token in the sequence.
The loader validates the range (`0 <= node_slot < 64`) but never requires
a matching node token.

Open spec question (flagged for the full Phase 4 run, not resolved here):
whether the frozen specs should pin down the empty-canvas anchor rule.

RESOLVED in the Phase 4 full run (2026-10-05): keep it teacher-local, do
not pin it in specs/. Rationale: specs/ is frozen (Phase 0 rule: no
changes without a version bump and retraining gate), and the anchor choice
is a teacher labeling policy, not executor semantics or token meaning. The
executor already implements and documents the rule in code
(teacher/lib/executor.mjs, _doFlag: "Teacher encoding rule for this spec
corner; the frozen specs do not pin it down"), and this file documents the
union-slot rule the loader enforces. If a second teacher implementation
ever appears, revisit: divergent anchor policies would poison supervision.
- `step_index`: int, position of this step inside the episode, 0-based.
- `input_ids`: array of uint16 token ids following the frozen
  `specs/token-schema.json`: BOS, node tokens, SNAPSHOT_SEP, edge tokens,
  ANNOT_SEP, annotation tokens, MENU_SEP, action-menu tokens, EOS.
  Separators are always present even when a section is empty.
- `fields`: array of canonical JSON strings (sorted keys, no whitespace),
  one per entry of `input_ids`, same order, same length. Tokens with no
  fields encode `"{}"`. Menu token field objects carry `action_name` and
  `params_digest`, matching the token schema.
- `menu_actions`: action names in menu order. Must equal, in order, the
  `action_name` values of the action-menu tokens inside `input_ids`.
- `gold_menu_index`: int, the teacher's chosen entry, an index into
  `menu_actions`.

Validation (the loader enforces all of these, failing loudly):

- `len(input_ids) == len(fields)`.
- `0 <= gold_menu_index < len(menu_actions)`, `len(menu_actions) <= 64`.
- Every id in `input_ids` is an int in `[0, 65535]`.
- `menu_actions` matches the menu section of `input_ids` name for name.
- Every `fields` entry parses as JSON.

## Corrupted sessions

About 40 percent of teacher sessions are corrupted on purpose (wrong prior
action, dangling reference, contradictory annotation) so the model learns
recovery. Corrupted steps are labeled with the correct recovery action
(`flag_for_review`, `undo_last`, `skip_recipe_item`, or `abort_session`)
exactly like clean steps. There is no separate flag: the label is the
supervision.

## Shard files

- One JSONL file per shard, e.g. `shard-00001.jsonl`.
- A `manifest.json` next to the shards lists shard files, step counts,
  recipe counts, domains, and the shard format version.
- Shards are published to the Hugging Face dataset repo; the training
  notebooks pull them from there. See `training/FIRE-CHECKLIST.md`.
