# training/

Phase 5. Supervised training on teacher labels, Kaggle primary, Colab fallback. ONNX export contract: pinned opset, no control-flow or custom ops, WebGPU validated, WASM fallback.

## Scaffold (committed ahead of the dataset so training fires the day it lands)

- `SHARD-FORMAT.md`: the dataset contract the scripted teacher must emit
  (JSONL shards, one labeled step per line, in-domain plus non-mapping
  domains, corrupted sessions labeled with the recovery action).
- `s1tokenize.py`: pure encoding from shard lines to model tensors
  (token ids, field hashes, action-name hashes, menu mask). Named to avoid
  shadowing the stdlib `tokenize` module.
- `model.py`: `TinyWorkflowModel`, a tiny transformer encoder with a pointer
  head over the action menu. The action names arrive in the input and are
  embedded by stable string hash, so the same weights serve new domains:
  modular and dynamic by construction.
- `data.py`: shard loader with loud validation, recipe-based train/val
  split, padded batch collation.
- `train.py`: supervised training loop, saves `checkpoint.pt` + `config.json`.
- `eval.py`: three suites. In-domain accuracy, out-of-domain accuracy on
  unseen domains (the modularity proof), and menu-permutation robustness
  (the model must read the menu, not memorize positions). Fails loudly if a
  gate fails.
- `export_onnx.py`: pinned opset 17 export with dynamic axes; validates
  torch vs onnxruntime numerically before accepting the file.
- `smoke/`: end-to-end loop test. `make_fixture.py` builds a tiny two-domain
  fixture in the shard format; `run_smoke.sh` trains 1 epoch on CPU, exports
  to ONNX, runs `eval.py`, and runs `infer.mjs` (Node + onnxruntime-node)
  asserting every output is a well-formed action sequence.
- `notebooks/kaggle-train.ipynb`: primary training run (GPU).
- `notebooks/colab-train.ipynb`: fallback training run (GPU).
- `MODEL-CARD.md`: draft card for `movahedi-ca/s1-workflow-tiny`.
- `FIRE-CHECKLIST.md`: the exact steps to run when the Phase 4 dataset lands.

## Status

Scaffold complete and smoke-tested. No training run yet: the dataset does
not exist until Phase 4 publishes it.
