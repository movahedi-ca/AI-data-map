# Dataset Card: AI Data Map Scripted-Teacher Shards (Phase 4 full run)

## Purpose

Teacher demonstrations for training the System-1 workflow executor of the
AI-data-map build (github.com/movahedi-ca/AI-data-map). Each shard is a
deterministic, scripted run of the frozen action grammar: a fixed recipe
plus the exact action sequence an expert teacher would take, recorded as
labeled steps in SHARD-FORMAT 1.0.0 (tokenized state plus valid-action
menu, gold menu index). These are the supervised training pairs
(menu state -> action) for the tiny in-browser model (Phase 5).

## Scale

- 33 shards, 526 labeled steps, 33 unique recipes.
- In-domain (`data-mapping/*`): 319 steps. Real browser sessions
  (template upload, column mapping, review, build, export, broken-file
  recovery) plus headless import variants and canvas view-transform
  sessions. Labels and graph shapes come from real inventory templates.
- Out-of-domain (`ood-*`): 207 steps. The same frozen grammar reused in
  unrelated workflows: conference planning, incident response, content
  pipeline, asset inventory, hiring, lab inventory, event ticketing,
  library catalog, volunteer rota, warehouse zones.
- Corrupted sessions: adversarial runs (dangling references, wrong
  labels, retention conflicts, flag storms, aborts, check-fix loops)
  teach recovery. Corrupted steps are labeled with the correct recovery
  action exactly like clean steps; there is no separate flag.

## Why the split

The build goal is a modular, dynamic workflow-execution module with a
domain-agnostic action vocabulary, data mapping as one instantiation. The
out-of-domain shards prove the executor generalizes: if the model learns
the action grammar from mapping data but performs on hiring pipelines and
warehouse zones, the vocabulary is genuinely domain-agnostic rather than
memorized labels. Training and eval report in-domain and out-of-domain
scores separately.

## Record format (SHARD-FORMAT 1.0.0)

One JSON object per line:

- `shard_format`: "1.0.0"
- `recipe_id`: steps sharing an id belong to one episode; splits are by
  recipe id, never by step.
- `domain`: `data-mapping/*` in-domain, `ood-*` out-of-domain. Never a
  model feature; used for eval splits.
- `step_index`, `input_ids` (uint16 token ids per specs/token-schema.json),
  `fields` (canonical JSON per token, same order), `menu_actions`
  (action names in menu order), `gold_menu_index` (teacher's choice).
- Annotation `node_slot` lives in the union slot space of canvas nodes
  and annotation anchors (a flag may anchor a not-yet-built node).

## Determinism

Scenarios are deterministic: fixed templates, fixed dates, fixed
statutes, seeded RNG. All 24 headless scenarios were run twice;
converted shards are byte-identical across runs (sha256). Every shard
replays cleanly through the teacher executor. See manifest.json for
per-shard sha256.

## License

MIT. No personal data: every shard is fully synthetic, with fixed
coordinates, fixed labels, and fixed dates.
