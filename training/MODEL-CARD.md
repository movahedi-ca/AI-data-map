# Model card: s1-workflow-tiny

## Model details

- **Name:** `movahedi-ca/s1-workflow-tiny`
- **Architecture:** tiny transformer encoder (4 layers, d_model 128, 4 heads)
  with a pointer head over the action menu. About 1M parameters.
- **Input:** tokenized workflow state plus the valid-action menu, per the
  frozen `specs/token-schema.json` (encoding version 1.0.0). 16-bit token ids
  plus per-token field objects.
- **Output:** a distribution over menu slots. The argmax is the chosen
  action. The model never sees a fixed action list: action names arrive in
  the input and are embedded through a stable string hash, so the same
  weights serve new recipes with new action names.
- **Format:** ONNX (opset 17, no control-flow or custom ops), run with
  onnxruntime-web in the browser. CPU-friendly, no network at inference.
- **License:** MIT.

## Intended use

A System-1 reflex for guided workflow tools: given the current state and the
valid actions, pick the next action. First instantiation: the Law 25 data
mapping guide. The model is a reusable module, not a single-task brain.

## Training data

Scripted-teacher demonstrations (Phase 4): the teacher is code, not an LLM.
About 40 percent of sessions are corrupted on purpose so the model learns
recovery (flag, undo, skip, abort). Domains: data-mapping plus at least one
non-mapping domain, so out-of-domain generalization is measurable. Dataset:
`movahedi-ca/ai-data-map-teacher` (shard format 1.0.0, see
`training/SHARD-FORMAT.md`).

## Evaluation

- In-domain menu-choice accuracy on held-out recipes.
- Out-of-domain accuracy on unseen domains with unseen action names: the
  modular/dynamic proof.
- Menu-permutation robustness: shuffling the menu order must not move
  accuracy, proving the model reads the menu instead of memorizing positions.
- See `training/eval.py` and the eval report published next to the weights.

## Limitations

- The model picks among the actions it is given; it cannot invent actions.
- It is a reflex, not a planner: one step at a time, no lookahead.
- Recovery behavior is only as good as the corrupted sessions in training.
- Any change to the token encoding version requires retraining.
