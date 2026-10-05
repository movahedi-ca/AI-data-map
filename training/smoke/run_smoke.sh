#!/bin/bash
# Smoke test: toy fixture -> 1 epoch of training -> ONNX export ->
# Node inference via onnxruntime-node -> well-formedness asserts.
# Proves the whole Phase 5 loop works before the real dataset lands.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TRAIN_DIR="$(dirname "$HERE")"
VENV="$HOME/workspace/goals/taiga-style-data-mapping-agent-on-movahedi-ca/hidden_files/phase5prep/venv"
OUT="$HERE/out"
FIXTURE="$OUT/fixture.jsonl"
CKPT="$OUT/checkpoint.pt"
MODEL="$OUT/model.onnx"

mkdir -p "$OUT"
export PYTHONPATH="$TRAIN_DIR"

echo "--- 1. synthetic fixture (two domains)"
"$VENV/bin/python" "$HERE/make_fixture.py" --out "$FIXTURE"

echo "--- 2. train 1 epoch (tiny model, CPU)"
"$VENV/bin/python" "$TRAIN_DIR/train.py" --shards "$FIXTURE" --out "$OUT" \
  --epochs 1 --batch 16 --d-model 64 --layers 2 --heads 2 --d-ff 128

echo "--- 3. export to ONNX (validates torch vs onnxruntime)"
"$VENV/bin/python" "$TRAIN_DIR/export_onnx.py" --checkpoint "$CKPT" --out "$MODEL"

echo "--- 4. eval harness dry run (gates at 0: exercises the harness, not accuracy)"
"$VENV/bin/python" "$TRAIN_DIR/eval.py" --checkpoint "$CKPT" --shards "$FIXTURE" \
  --report "$OUT/eval-report.json" --train-domains "data-mapping" \
  --indomain-gate 0 --ood-gate 0 --perm-tolerance 1.0
cat "$OUT/eval-report.json"

echo "--- 5. node inference via onnxruntime-node"
cd "$HERE"
if [ ! -d node_modules/onnxruntime-node ]; then
  npm install --no-audit --no-fund onnxruntime-node
fi
node infer.mjs "$MODEL" "$FIXTURE"

echo "SMOKE COMPLETE"
