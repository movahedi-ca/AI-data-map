"""Supervised training for the tiny workflow model.

Reads teacher JSONL shards, trains the pointer head with cross-entropy over
menu positions, saves checkpoint.pt and config.json.
"""

import argparse
import json
import os

import torch
import torch.nn as nn
from torch.utils.data import DataLoader

from data import ShardDataset, collate, load_shards, split_by_recipe
from model import TinyWorkflowModel, model_config_dict


def train(args):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"device: {device}")
    steps = load_shards(args.shards)
    print(f"loaded {len(steps)} steps from {len(args.shards)} shard(s)")
    train_steps, val_steps = split_by_recipe(steps, val_frac=args.val_frac)
    print(f"train {len(train_steps)} steps, val {len(val_steps)} steps (by recipe)")
    train_dl = DataLoader(
        ShardDataset(train_steps), batch_size=args.batch, shuffle=True,
        collate_fn=collate,
    )
    val_dl = DataLoader(
        ShardDataset(val_steps), batch_size=args.batch, collate_fn=collate,
    )
    model = TinyWorkflowModel(
        d_model=args.d_model, n_layer=args.layers, n_head=args.heads,
        d_ff=args.d_ff, dropout=args.dropout,
    ).to(device)
    print(f"params: {sum(p.numel() for p in model.parameters()):,}")
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr)
    loss_fn = nn.CrossEntropyLoss()
    os.makedirs(args.out, exist_ok=True)

    for epoch in range(1, args.epochs + 1):
        model.train()
        total, n = 0.0, 0
        for b in train_dl:
            b = {k: v.to(device) if torch.is_tensor(v) else v for k, v in b.items()}
            opt.zero_grad()
            scores = model(
                b["tok_ids"], b["field_hash"], b["name_hash"], b["menu_mask"]
            )
            loss = loss_fn(scores, b["gold_pos"])
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            total += loss.item() * len(b["gold_pos"])
            n += len(b["gold_pos"])
        model.eval()
        correct, total_v, vloss = 0, 0, 0.0
        with torch.no_grad():
            for b in val_dl:
                b = {k: v.to(device) if torch.is_tensor(v) else v for k, v in b.items()}
                scores = model(
                    b["tok_ids"], b["field_hash"], b["name_hash"], b["menu_mask"]
                )
                vloss += loss_fn(scores, b["gold_pos"]).item() * len(b["gold_pos"])
                pred = scores.argmax(dim=-1)
                correct += (pred == b["gold_pos"]).sum().item()
                total_v += len(b["gold_pos"])
        print(
            f"epoch {epoch}: train_loss={total / max(n, 1):.4f} "
            f"val_loss={vloss / max(total_v, 1):.4f} "
            f"val_acc={correct / max(total_v, 1):.4f}"
        )

    ckpt = os.path.join(args.out, "checkpoint.pt")
    torch.save(
        {
            "state_dict": model.state_dict(),
            "config": model_config_dict(model),
            "hparams": vars(args),
        },
        ckpt,
    )
    with open(os.path.join(args.out, "config.json"), "w", encoding="utf-8") as fh:
        json.dump(model_config_dict(model), fh, indent=2)
    print(f"saved {ckpt}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--shards", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=5)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--d-model", type=int, default=128)
    ap.add_argument("--layers", type=int, default=4)
    ap.add_argument("--heads", type=int, default=4)
    ap.add_argument("--d-ff", type=int, default=256)
    ap.add_argument("--dropout", type=float, default=0.1)
    train(ap.parse_args())
