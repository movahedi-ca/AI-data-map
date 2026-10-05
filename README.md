# AI-data-map

A Taiga-style System-1 executor that builds Law 25 data-mapping canvases step by step, entirely in the visitor's browser.

Four layers, each in its lane:

| Layer | Role |
|---|---|
| Chatbot | The mouth. Asks 4 questions, builds the recipe from deterministic templates. Zero LLM tokens in v1. Never executes. |
| MCP | The nervous system. `execute_mapping_workflow(recipe)` validates the recipe and returns a session ticket. |
| Tools | The muscles. The mapping-guide canvas, the Excel importer, the exporter. |
| System-1 | The reflexes. A typed-token transformer (~1.2M params) over the state snapshot that picks the next action from the catalogue menu. Runs locally via onnxruntime-web. |

The planner writes the recipe. The executor does the clicking. That is the Taiga split.

## Layout

- `specs/` - frozen specs: recipe language, token encoding, state snapshot schema, action catalogue, retention rule (Phase 0)
- `teacher/` - scripted Playwright teacher plus synthetic org generator (Phase 4)
- `training/` - training scripts and eval harness, Kaggle primary (Phase 5)
- `web/` - in-browser executor, narrating step log, review loop UI (Phase 6)
- `vendor-kb/` - about 100 classified SaaS tools with verified retention ranges (Phase 3)
- `s1map/` - tiny Python package: `from_pretrained`, `drive`, `evaluate`
- `tests/` - unit and security tests (1000+ target, later track)

## Status

Phase 0 (freeze and spec) in progress. Full 7-phase build plan in the playbook.

## The bar

Four chip taps to start. The map builds itself live with a narrating step log. Under 30 seconds a run. Every auto-placed node gets a one-tap confirm or fix. One click downloads a draft Excel inventory. One click wipes the session. Zero third-party scripts. Everything client-side.

## License

MIT. See LICENSE.
