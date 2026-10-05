# Fire-training checklist (run when the Phase 4 dataset lands)

Everything below assumes the training scaffold in `training/` is committed
and the teacher dataset is published. Do the steps in order; stop loudly at
the first failure.

## 1. Confirm the dataset

- Dataset repo: `movahedi-ca/ai-data-map-teacher` on the Hugging Face Hub.
- Check `manifest.json`: shard files present, step counts sane, domains
  include data-mapping plus at least one non-mapping domain, shard format
  is `1.0.0`.
- Spot-check one shard line against `training/SHARD-FORMAT.md`.

## 2. Validate the shards (CPU, minutes)

From a checkout of this repo:

```
cd training
python -c "from data import load_shards; print(len(load_shards([...]))))"
```

The loader rejects bad lines loudly. Fix the teacher output, not the
loader, if validation fails.

## 3. Launch training (Kaggle primary)

- Open `training/notebooks/kaggle-train.ipynb` on Kaggle.
- Enable a GPU accelerator. Add the `HF_TOKEN` secret (write access to
  `movahedi-ca/s1-workflow-tiny`).
- Run all cells. Expected: ~12 epochs, train loss falling, val accuracy
  reported per epoch.

## 4. Export and gate (same notebook)

- `export_onnx.py` must print "ONNX validation passed".
- `eval.py` gates: in-domain accuracy >= 0.85, out-of-domain >= 0.60,
  menu-permutation drift <= 0.10. If a gate fails, do not push: adjust
  hyperparameters or grow the teacher dataset, then retrain.

## 5. Push the weights

The notebook uploads `model.onnx`, `checkpoint.pt`, `config.json`,
`eval-report.json`, and the model card to `movahedi-ca/s1-workflow-tiny`.

## 6. Colab fallback

If Kaggle is unavailable or the GPU quota is spent, run
`training/notebooks/colab-train.ipynb` instead (same cells, Colab GPU
runtime, `HF_TOKEN` from Colab Secrets). The browser session for Colab is
signed in as Mohammad Hossein Movahedi.

## 7. Record the integration

- Compute the SHA-256 of `model.onnx` and append it to
  `web/import/INTEGRATION-NOTE.md` next to the Phase 1 CSP hashes, so the
  Phase 7 deploy pins the exact weights.
- Note the eval report numbers in the Phase 5 completion report.
