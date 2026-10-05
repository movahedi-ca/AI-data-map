# AI-data-map: client-side AI for Law 25 data mapping

AI-data-map is a client-side AI workflow executor whose first use case is Quebec Law 25 data mapping: answer four intake questions and it builds your privacy inventory canvas step by step, entirely in the visitor's browser. No servers, no accounts, no telemetry, zero third-party scripts. A tiny System-1 transformer model (about 1.2M parameters, ONNX format, running in the browser with onnxruntime-web) picks each next action from a versioned action catalogue, so your data mapping never leaves your device. A chatbot asks the intake questions and drafts a recipe from deterministic templates, zero LLM tokens in v1. An MCP tool validates the recipe before anything runs. The mapping-guide canvas and the Excel importer and exporter do the clicking. Every auto-placed node gets a one-tap confirm or fix, every output is a draft inventory for human review (never legal advice), retention values are ranges that cite the statute plus an as-of date, and one click wipes the session. Open source under the MIT license.

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

Specs frozen (Phase 0), teacher data built (Phase 4), model trained (Phase 5), in-browser executor shipped (Phase 6). Phase 7 (visibility stack) in progress. Full 7-phase build plan in the playbook.

## The bar

Four chip taps to start. The map builds itself live with a narrating step log. Under 30 seconds a run. Every auto-placed node gets a one-tap confirm or fix. One click downloads a draft Excel inventory. One click wipes the session. Zero third-party scripts. Everything client-side.

## License

MIT. See LICENSE.
