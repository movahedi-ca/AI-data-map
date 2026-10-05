# Dataset Card: AI Data Map Scripted-Teacher Shards (Phase 4 pilot)

## Purpose

Teacher demonstrations for training the System-1 workflow executor of the AI
data-map build. Each shard is a deterministic, scripted run of the frozen
action grammar against the Phase 0 guide model: a fixed recipe plus the exact
action sequence an expert teacher would take, recorded as state-hash-chained
records with full snapshots. The Phase 4 scripted-teacher harness turns these
records into supervised training pairs (menu state -> action) for the tiny
in-browser model.

## In-domain vs out-of-domain split

- **In-domain shards** (`import-basic`, `import-broken`): the grammar used
  for its original purpose, building a personal-data inventory map from the
  Excel template import. These teach the core mechanics: collection points,
  system/thirdparty nodes, flows, retention citations, checks, export.
- **Out-of-domain shards** (`ood-conference`, `ood-incident`, `ood-content`,
  `ood-asset`): the same frozen grammar reused in unrelated workflows:
  conference planning, security incident triage, editorial pipeline, IT asset
  inventory. The labels and story change; the actions, menus, undo semantics,
  and checks do not.

Why: the Phase 4 goal is a modular, dynamic workflow-execution module with a
domain-agnostic action vocabulary, data mapping as one instantiation. The
out-of-domain shards prove the executor generalizes: if the model learns the
action grammar from mapping data but performs on conference planning and
incident triage, the vocabulary is genuinely domain-agnostic rather than
memorized labels.

## Record format

Each shard ships as two files:

- `<shard>.jsonl`: one JSON record per action, in order. Fields: `step`,
  `menu_before` (the valid-action menu the teacher saw), `action`
  (`action_id`, `params`), `state_hash` (SHA-256 over canonical
  {nodes, edges, annotations}), `snapshot_after` (full executor snapshot);
  step 0 also carries `snapshot_before`.
- `<shard>.manifest.json`: shard name, domain, recipe_id, the full recipe
  (so replay is self-contained), step count, first/last state hashes,
  creation timestamp.

Snapshots validate against `state-snapshot-schema.json`; recipes validate
against `recipe-schema.json`. Every shard replays byte-deterministically via
`lib/replay.mjs`.

## Schema versions

- Recipe schema: `1.0.x` (executor supports 1.0.x)
- State snapshot schema: `1.0.0`
- Action catalogue: the 12 frozen actions in `specs/action-catalogue.json`

## License

MIT. No personal data: every shard is fully synthetic, with fixed
coordinates, fixed labels, and fixed dates.

## TODO for the full Phase 4 run

- [ ] Scale the in-domain corpus: dozens of template-import variants
      (different sheet splits, broken columns, multi-sheet workbooks).
- [ ] Scale the out-of-domain set: more workflows (hiring pipeline, lab
      inventory, event ticketing) to harden the domain-agnostic claim.
- [ ] Add adversarial teacher runs: deliberate menu violations, flag storms,
      undo chains, abort mid-recipe, and their recoveries.
- [ ] Convert shards to training pairs: (menu_before + canvas summary) ->
      (action, params), with a held-out OOD evaluation split.
- [ ] Publish to Hugging Face (datasets): dataset viewer config, train/eval
      splits, datasheet for datasets, DOI via the HF paper page.
- [ ] Write the Phase 5 training/eval plan that proves out-of-domain reuse
      on the trained model, per the modular-and-dynamic instruction.
