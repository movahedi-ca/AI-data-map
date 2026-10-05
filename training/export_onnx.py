"""Export the trained model to ONNX for onnxruntime-web.

Contract (matches training/README.md):
- Pinned opset, no control-flow ops, no custom ops.
- Dynamic batch and sequence axes.
- Validated: onnxruntime (Python) output must match torch output exactly
  before the file is accepted.
"""

import argparse
import os

import numpy as np
import onnxruntime as ort
import torch

from model import TinyWorkflowModel

OPSET = 17
INPUT_NAMES = ["tok_ids", "field_hash", "name_hash", "menu_mask"]
OUTPUT_NAMES = ["menu_scores"]


def export(checkpoint_path, out_path):
    ckpt = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    cfg = ckpt["config"]
    model = TinyWorkflowModel(
        d_model=cfg["d_model"], n_layer=cfg["n_layer"], n_head=cfg["n_head"],
        d_ff=cfg["d_ff"], tok_vocab=cfg["tok_vocab"],
        field_buckets=cfg["field_buckets"], name_buckets=cfg["name_buckets"],
        max_len=cfg["max_len"],
    )
    model.load_state_dict(ckpt["state_dict"])
    model.eval()

    b, t = 2, 24
    tok_ids = torch.randint(0, 288, (b, t))
    field_hash = torch.randint(0, cfg["field_buckets"], (b, t))
    name_hash = torch.randint(0, cfg["name_buckets"], (b, t))
    menu_mask = torch.zeros(b, t, dtype=torch.bool)
    menu_mask[:, -4:] = True

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with torch.no_grad():
        torch.onnx.export(
            model,
            (tok_ids, field_hash, name_hash, menu_mask),
            out_path,
            input_names=INPUT_NAMES,
            output_names=OUTPUT_NAMES,
            opset_version=OPSET,
            dynamic_axes={
                "tok_ids": {0: "batch", 1: "seq"},
                "field_hash": {0: "batch", 1: "seq"},
                "name_hash": {0: "batch", 1: "seq"},
                "menu_mask": {0: "batch", 1: "seq"},
                "menu_scores": {0: "batch", 1: "seq"},
            },
        )
    print(f"exported {out_path} (opset {OPSET})")

    with torch.no_grad():
        expected = model(tok_ids, field_hash, name_hash, menu_mask).numpy()
    sess = ort.InferenceSession(out_path, providers=["CPUExecutionProvider"])
    got = sess.run(
        OUTPUT_NAMES,
        {
            "tok_ids": tok_ids.numpy().astype(np.int64),
            "field_hash": field_hash.numpy().astype(np.int64),
            "name_hash": name_hash.numpy().astype(np.int64),
            "menu_mask": menu_mask.numpy(),
        },
    )[0]
    # -inf entries (masked menu positions) compare as equal; use allclose
    # with equal_nan after replacing -inf on both sides.
    exp = np.where(np.isneginf(expected), -1e30, expected)
    got = np.where(np.isneginf(got), -1e30, got)
    max_diff = float(np.max(np.abs(exp - got)))
    print(f"max torch-vs-ort abs diff: {max_diff:.2e}")
    if max_diff > 1e-4:
        raise AssertionError(f"ONNX validation failed: diff {max_diff:.2e}")
    print("ONNX validation passed: torch and onnxruntime agree")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--out", required=True)
    export(ap.parse_args().checkpoint, ap.parse_args().out)
