# Teacher: scripted Playwright data generator

The teacher drives the data-mapping tool in a real browser (and headless
grammar scenarios in Node) and records every session as a sequence of
(state snapshot, valid-action menu) -> action records conforming to the
frozen specs in `../specs/`. The records are the training data for the
Phase 5 System-1 model.

## Layout

- `lib/executor.mjs`: implements the action catalogue (all 12 actions)
  against the canonical canvas model: preconditions, idempotency keys,
  undo tombstones, flag gating, termination, the 32-record window with the
  prefix hash chain, and SHA-256 state hashes over the canonical
  serialization. This is the source of truth for record traces.
- `lib/recorder.mjs`: wraps an Executor, appends one record per action
  {step, menu_before, action {action_id, params}, state_hash,
  snapshot_after} (first record also carries snapshot_before), writes
  `<shard>.jsonl` + `<shard>.manifest.json` (manifest embeds the full
  recipe so replay is self-contained).
- `lib/validate.mjs`: validates snapshots and recipes against the JSON
  schemas via python jsonschema (offline, no npm installs).
- `lib/replay.mjs`: re-executes a shard through a fresh Executor and
  compares every state_hash. A green replay means the trace is
  deterministic.
- `driver/mcp-client.mjs`: stdio JSON-RPC client for the localhost-qa
  headless-Chrome MCP server.
- `driver/serve.mjs`: serves a copy of the Phase 1 import demo on
  127.0.0.1 for the browser scenarios.
- `scenarios/`: scenario plugins. Each exports `name`, `domain`, and
  `async function run(ctx)`. The import scenarios drive the real browser;
  the ood-* scenarios run headless through the Executor.
- `pilot/`: pilot shards and the pilot report (small, committed).

## Scenario plugins

Scenario plugins are the extension point. Phase 2 canvas actions
(zoom, pan, fit-to-view, fullscreen) slot in as a new plugin without
touching the harness: a plugin reads page state, calls
`recorder.rec(name, params)`, and asserts what it needs. The plugin
interface is `run(ctx)` with ctx = {client, base, specsDir, libDir,
outDir, templatePath, rng}.

## In-domain vs out-of-domain

The model must learn the recipe-to-action grammar, not just data-mapping
demonstrations (modular/dynamic requirement). The dataset carries an
explicit split:

- `data-mapping/*`: real browser sessions: template upload, column
  mapping, review, build, export, plus broken-file recovery. Labels and
  graph shapes come from real inventory templates.
- `ood-*`: headless scenarios that reuse the same action grammar for
  other workflows (conference planning, incident response, content
  pipeline, asset inventory). Same node types, edge categories, and
  recovery actions; different label distributions, graph shapes, and
  recipe structures. The grammar is identical, the domain is not.

Training and eval must report in-domain and out-of-domain scores
separately. Out-of-domain generalization is the acceptance bar for the
modular model.

## Determinism

Scenarios are deterministic: fixed template files, fixed dates, fixed
statutes, seeded RNG. The same scenario run twice produces byte-identical
shards. Replay (`lib/replay.mjs`) is the check.

## Pilot

`pilot/run.mjs` runs the import-basic browser scenario plus the ood
scenarios, validates every snapshot, replays every shard, and writes
`pilot/report.json`. The pilot is small by design; full-scale generation
and Hugging Face publication happen when Phase 4 officially runs.
