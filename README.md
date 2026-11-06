# AI-data-map

[![Architecture diagram](https://gitdiagram.com/diagram-badge.svg)](https://gitdiagram.com/movahedi-ca/AI-data-map?utm_source=readme&utm_medium=badge)

**Client-side AI for Quebec Law 25 data mapping.**  
No servers for inference. No accounts. No telemetry. Zero third-party scripts.

AI-data-map is a client-side System-1 workflow executor. Its first use case is Quebec Law 25 (Loi 25) privacy data mapping: answer four intake questions and it builds a draft privacy-inventory canvas step by step, entirely in the visitor’s browser. A tiny typed-token transformer (~1.2M parameters, ONNX, running via onnxruntime-web) picks each next action from a versioned action catalogue. A chatbot asks the intake questions and drafts a recipe from deterministic templates (zero LLM tokens in v1). An MCP tool validates the recipe before anything runs. The mapping-guide canvas and the Excel importer/exporter do the clicking.

Every auto-placed node gets a one-tap confirm or fix. Every output is a **draft inventory for human review** — never legal advice and never a compliance verdict. Retention values are ranges that cite the statute plus an as-of date. One click downloads a draft Excel workbook; one click wipes the session.

**Live tools**

- English: https://movahedi.ca/tools/data-mapping-guide/assistant/
- French: https://movahedi.ca/fr/outils/guide-cartographie-donnees/assistant/

**License:** MIT · **Status:** in-browser executor shipped (Phase 6); MCP visibility stack in progress (Phase 7)

---

## Overview

AI-data-map solves a practical problem for organizations that must produce a Law 25-style privacy inventory: the work is repetitive, easy to get wrong, and sensitive enough that the data should not leave the device. The system keeps the entire mapping session in the browser. A small local model chooses the next canvas action; humans review every auto-placed node before anything is treated as final.

Intended users are privacy officers, compliance teams, and consultants who need a fast, private draft map they can export and review offline.

### Four layers (the Taiga split)

| Layer | Role |
|-------|------|
| **Chatbot** | The mouth. Asks four intake questions and builds the recipe from deterministic templates. Zero LLM tokens in v1. Never executes. |
| **MCP** | The nervous system. `execute_mapping_workflow(recipe)` validates the recipe against the frozen schema and returns a session ticket. Does not execute. |
| **Tools** | The muscles. Mapping-guide canvas, Excel importer, Excel exporter. |
| **System-1** | The reflexes. Typed-token transformer (~1.2M params) over the state snapshot; picks the next action from the catalogue menu. Runs locally via onnxruntime-web. |

The planner writes the recipe. The executor does the clicking.

---

## Key features

- **Fully client-side** — inference, canvas, import, export, and wipe all run in the browser.
- **Zero third-party scripts** on shipped pages; CSP-friendly bundles with pinned hashes.
- **Tiny System-1 model** — ~1.2M parameters, ONNX opset 17, WebGPU with WASM fallback.
- **Deterministic chatbot** — template-driven recipe drafting, no network calls for generation.
- **MCP validation** — recipe schema + action-catalogue checks before a session is ticketed.
- **Human review loop** — every auto-placed node requires confirm or fix; done-heads emit “verify” flags.
- **Retention ranges only** — never a single number; each value cites statute + as-of date.
- **Bilingual (EN/FR)** narrations and UI.
- **One-click session wipe** and draft Excel export.
- **Scripted teacher data** (Playwright + headless) published for reproducibility; no LLM-generated training traces.

---

## Project status

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Frozen specs (recipe language, tokens, state snapshot, action catalogue, retention rule) | Complete |
| 3 | Vendor knowledge base (~100 classified SaaS tools, verified retention ranges) | Complete |
| 4 | Scripted Playwright teacher + synthetic org generator | Complete |
| 5 | System-1 training + ONNX export | Complete (50-epoch weights; in-domain ≈ 0.978, OOD ≈ 0.986) |
| 6 | In-browser executor, narrating step log, review loop, Excel export | Shipped |
| 7 | MCP server, session tickets, optional HTTP/SSE bridge | In progress |

Model weights and teacher dataset are published on Hugging Face under MIT:

- Model: https://huggingface.co/movahedi-ca/s1-workflow-tiny
- Dataset: https://huggingface.co/movahedi-ca/ai-data-map-teacher

---

## Requirements

### For the live tool (end users)

- A modern browser with WebAssembly support (Chrome, Firefox, Safari, Edge recent versions).
- No account, no install, no server-side credentials.

### For developers / contributors

- **Node.js** ≥ 18 (MCP server, tests, scanning).
- **Python** 3.x (training, eval, teacher validation) when working on Phase 4/5.
- Optional: Playwright / headless Chrome for regenerating teacher shards.
- Optional: GPU (Kaggle / Colab) for retraining; CPU is enough for smoke tests.

No npm dependencies are required for the MCP package (`mcp/package.json` lists none).

---

## Quick start

### Use the shipped tool

Open the live assistant and answer the four intake questions:

- EN: https://movahedi.ca/tools/data-mapping-guide/assistant/
- FR: https://movahedi.ca/fr/outils/guide-cartographie-donnees/assistant/

The canvas builds live with a narrating step log. Confirm or fix each auto-placed node. Download the draft Excel inventory when ready. Use “wipe” to clear the session.

### Run the MCP server (Phase 7)

```bash
git clone https://github.com/movahedi-ca/AI-data-map.git
cd AI-data-map
node mcp/server.js
```

The server speaks JSON-RPC 2.0 over stdio (`initialize`, `tools/list`, `tools/call`). Primary tool:

```text
execute_mapping_workflow(recipe)  →  session ticket or structured validation error
```

Optional HTTP bridge (127.0.0.1 only):

```bash
AI_DATA_MAP_BRIDGE_PORT=8787 node mcp/http-bridge.js
# or mount the bridge in-process:
AI_DATA_MAP_BRIDGE_PORT=8787 node mcp/server.js
```

Contract test:

```bash
node mcp/test-contract.js
```

See `mcp/README.md` and `mcp/openapi.yaml` for the full protocol, limits, and error shapes.

### Run the test suite

```bash
node tests/run-all.js
bash scanning/layer1/run.sh   # fast linter (must be clean)
```

---

## Architecture

```
┌─────────────┐     recipe JSON      ┌──────────────────┐
│   Chatbot   │ ───────────────────► │   MCP server     │
│ (templates) │                      │  (validate only) │
└─────────────┘                      └────────┬─────────┘
                                              │ session ticket
                                              ▼
                                     ┌──────────────────┐
                                     │ In-browser       │
                                     │ executor         │
                                     │  · System-1 ONNX │
                                     │  · canvas / UI   │
                                     │  · review loop   │
                                     │  · Excel export  │
                                     └──────────────────┘
```

- **Specs** (`specs/`) are frozen. Schema or catalogue changes require a version bump and a retraining gate.
- **Teacher** (`teacher/`) drives the real canvas (and headless OOD scenarios) and records deterministic (state, menu) → action traces.
- **Training** (`training/`) loads shards, trains the tiny transformer, evaluates in-domain / out-of-domain / menu-permutation robustness, and exports ONNX.
- **Web** (`web/`) hosts the chatbot, canvas, executor, importer, exporter, and site-integration bundles.
- **MCP** (`mcp/`) validates recipes and issues tickets; execution stays in the page.

Executor runtime hooks (`window.__s1executor` / `S1Executor.hooks`) are documented in `web/executor/EXECUTOR-API.md` (`state()`, `trace()`, `reset()`, `start`, `stepOnce`, `runAll`, etc.).

---

## Project structure

```
.
├── README.md
├── LICENSE                 # MIT
├── llms.txt                # Machine-readable project summary
├── sitemap.xml
├── specs/                  # Frozen Phase-0 contracts
│   ├── recipe-schema.json
│   ├── token-schema.json
│   ├── state-snapshot-schema.json
│   ├── action-catalogue.json
│   ├── RECIPE-VOCABULARY.md
│   ├── RETENTION-RULE.md
│   └── SAMPLE-RECIPE.json
├── teacher/                # Scripted Playwright + headless generator
│   ├── lib/                # executor, recorder, replay, validate
│   ├── driver/
│   ├── pilot/              # Pilot shards + manifests
│   └── DATASET-CARD.md
├── training/               # Model, data loader, train, eval, ONNX export
│   ├── model.py
│   ├── train.py
│   ├── eval.py
│   ├── export_onnx.py
│   ├── MODEL-CARD.md
│   └── notebooks/
├── web/                    # Shipped browser assets
│   ├── chatbot/
│   ├── canvas/
│   ├── executor/           # ONNX runtime, step log, review, export
│   ├── import/
│   ├── legal/
│   └── site-integration/
├── mcp/                    # Phase-7 MCP server + optional HTTP bridge
│   ├── server.js
│   ├── http-bridge.js
│   ├── openapi.yaml
│   └── test-contract.js
├── vendor-kb/              # Classified SaaS tools + retention ranges
├── data/                   # Supporting datasets (e.g. subprocessor graph)
├── scanning/               # Layered code-scanning pipeline
│   ├── layer1/             # Fast linter (runs on every push)
│   ├── layer2/             # Pattern rules (Semgrep-style)
│   ├── layer3/             # Tree-sitter code graph
│   └── nightly.sh
├── tests/
├── s1map/                  # Tiny Python package (from_pretrained, drive, evaluate)
└── .github/workflows/      # tests + nightly scan
```

---

## Configuration and limits

### MCP recipe limits (enforced server-side)

- At most **200 items** per recipe.
- At most **64 KB** of serialized recipe JSON.
- At most **4096 bytes** of serialized params per item.
- `schema_version` must match `1.0.x`.
- `recipe_id` must match `^[A-Za-z0-9_-]+$` (1–128 chars).
- Executor-only recovery intents (`undo_last`, `skip_recipe_item`, `abort_session`) are rejected inside recipes; they run only in the page.

### Environment variables (MCP / bridge)

| Variable | Purpose |
|----------|---------|
| `AI_DATA_MAP_BRIDGE_PORT` | When set, starts the optional HTTP bridge on `127.0.0.1:<port>` |

Sessions are in-memory only; restarting the server drops them by design (Phase 7 has no persistence surface).

---

## Development

```bash
# Clone
git clone https://github.com/movahedi-ca/AI-data-map.git
cd AI-data-map

# Unit + security tests
node tests/run-all.js

# Fast linter (must exit 0)
bash scanning/layer1/run.sh

# Full deep scan (layers 1–3 + tests)
bash scanning/nightly.sh

# MCP contract test
node mcp/test-contract.js
```

Training smoke (requires Python deps for the smoke path):

```bash
cd training/smoke
# see training/README.md and FIRE-CHECKLIST.md for the full sequence
```

Specs under `specs/` are frozen. Any change to token encoding, recipe schema, or the action catalogue requires a version bump and a retraining gate before new weights are accepted.

---

## Testing and scanning

| Path | What it does |
|------|----------------|
| `node tests/run-all.js` | Full unit + security suite |
| `scanning/layer1/run.sh` | Fast hygiene linter (`node --check`, no em-dashes, no leftover console/debugger, no eval) |
| `scanning/layer2/run.sh` | Pattern rules: exfiltration sinks, dangerous HTML, formula injection, proto pollution, secrets, insecure random |
| `scanning/layer3/run.sh` | Tree-sitter graph: dead code, unused exports, TODOs, duplicates |
| `scanning/nightly.sh` | Layers 1–3 + tests; writes a timestamped report under `scanning/reports/` |
| `mcp/test-contract.js` | Spawns the MCP server over stdio and asserts ticket/error shapes |

CI:

- `.github/workflows/test.yml` — push/PR: tests + layer 1.
- `.github/workflows/nightly-scan.yml` — nightly full scan; report uploaded as artifact.

Findings are tracked in `scanning/FINDINGS.md` and worked in severity order.

---

## Key guarantees

- **Client-side only** for the mapping tool: no server inference, no telemetry, no accounts, zero third-party scripts on shipped pages.
- **Outputs are drafts**: done-heads emit “verify” flags; checks surface flags and never declare a mapping compliant.
- **Retention values are ranges only**, each citing the actual statute and an as-of date.
- **Training data is scripted** (Playwright teacher + headless OOD scenarios), not LLM-generated; published under MIT.
- **Eval targets** (recorded against published weights): high task success on held-out synthetic orgs, strong length and unseen-vendor generalization, recovery after injected wrong actions, sub-5 ms per action in-browser under typical conditions.

These guarantees are design commitments of the current codebase; always re-verify against the live tool and the latest model card before relying on them for a specific deployment.

---

## Limitations

- The System-1 model is a **reflex**, not a planner: one step at a time, no lookahead; it only chooses among the actions it is given.
- Any change to the token encoding version requires retraining.
- MCP sessions are **ephemeral** (in-memory); the server does not persist tickets across restarts.
- The live tool is a **drafting aid**, not legal advice and not a compliance determination.
- Teacher regeneration and full training runs need additional tooling (Playwright, GPU) that is documented under `teacher/` and `training/` but is not required to use the shipped web tool.

---

## Contributing

1. Open an issue describing the change or bug.
2. Keep commits focused; do not change frozen specs without an explicit version bump and retraining plan.
3. Run `node tests/run-all.js` and `bash scanning/layer1/run.sh` before opening a PR.
4. Prefer updating the relevant `README.md` / ADR-style notes under the package you touch.
5. Submit a pull request against `main`.

Security-sensitive findings should be reported via the repository issue tracker or privately to the maintainer.

---

## License

MIT License. Copyright (c) 2026 Mohammad Movahedi. See [LICENSE](LICENSE).

---

## Support and references

| Resource | Link |
|----------|------|
| Source | https://github.com/movahedi-ca/AI-data-map |
| Issues | https://github.com/movahedi-ca/AI-data-map/issues |
| Live tool (EN) | https://movahedi.ca/tools/data-mapping-guide/assistant/ |
| Live tool (FR) | https://movahedi.ca/fr/outils/guide-cartographie-donnees/assistant/ |
| Model card / weights | https://huggingface.co/movahedi-ca/s1-workflow-tiny |
| Teacher dataset | https://huggingface.co/movahedi-ca/ai-data-map-teacher |
| Executor API | [web/executor/EXECUTOR-API.md](web/executor/EXECUTOR-API.md) |
| MCP protocol | [mcp/README.md](mcp/README.md), [mcp/openapi.yaml](mcp/openapi.yaml) |
| Specs | [specs/](specs/) |
| llms.txt | [llms.txt](llms.txt) |

The detailed multi-phase playbook that drove the build lives outside this repository; the code, frozen specs, model card, and the documents under each package are the authoritative description of the shipped system.
