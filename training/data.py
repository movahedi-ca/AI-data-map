"""Dataset loader for teacher shards. Reads SHARD-FORMAT.md, validates loudly."""

import json

import torch
from torch.utils.data import Dataset

from s1tokenize import encode_step, MENU_LO, ANNOT_LO, ANNOT_HI


REQUIRED_KEYS = (
    "shard_format",
    "recipe_id",
    "domain",
    "step_index",
    "input_ids",
    "fields",
    "menu_actions",
    "gold_menu_index",
)
SHARD_FORMAT = "1.0.0"


def validate_line(line: dict, lineno: int, source: str) -> dict:
    for key in REQUIRED_KEYS:
        if key not in line:
            raise ValueError(f"{source}:{lineno}: missing key {key!r}")
    if line["shard_format"] != SHARD_FORMAT:
        raise ValueError(
            f"{source}:{lineno}: shard_format {line['shard_format']!r} "
            f"is not {SHARD_FORMAT!r}; refusing to guess"
        )
    ids, fields, menu = line["input_ids"], line["fields"], line["menu_actions"]
    if len(ids) != len(fields):
        raise ValueError(f"{source}:{lineno}: ids/fields length mismatch")
    if not (0 <= line["gold_menu_index"] < len(menu)):
        raise ValueError(f"{source}:{lineno}: gold_menu_index out of range")
    if len(menu) > 64:
        raise ValueError(f"{source}:{lineno}: menu longer than 64 entries")
    enc = encode_step(ids, fields)
    # Annotation anchors: node_slot lives in the union slot space of canvas
    # nodes and annotation anchors (see SHARD-FORMAT.md), so it may point at
    # a slot with no corresponding node token. Validate the range only.
    for i, tid in enumerate(ids):
        if ANNOT_LO <= tid < ANNOT_HI:
            slot = json.loads(fields[i]).get("node_slot")
            if not isinstance(slot, int) or not (0 <= slot < 64):
                raise ValueError(
                    f"{source}:{lineno}: annotation token has bad node_slot "
                    f"{slot!r}"
                )
    if not isinstance(line["domain"], str) or not line["domain"]:
        raise ValueError(f"{source}:{lineno}: domain must be a non-empty string")
    menu_positions = [i for i, m in enumerate(enc["menu_mask"]) if m]
    # Menu names in the token stream must match menu_actions in order.
    names = [json.loads(fields[i])["action_name"] for i in menu_positions]
    if names != list(menu):
        raise ValueError(
            f"{source}:{lineno}: menu_actions {menu} does not match "
            f"menu token names {names}"
        )
    gold_pos = menu_positions[line["gold_menu_index"]]
    return {
        "recipe_id": line["recipe_id"],
        "domain": line["domain"],
        "step_index": line["step_index"],
        "tok_ids": enc["tok_ids"],
        "field_hash": enc["field_hash"],
        "name_hash": enc["name_hash"],
        "menu_mask": enc["menu_mask"],
        "menu_actions": list(menu),
        "gold_menu_index": line["gold_menu_index"],
        "gold_pos": gold_pos,
    }


def load_shards(paths):
    steps = []
    for path in paths:
        with open(path, encoding="utf-8") as fh:
            for lineno, raw in enumerate(fh, 1):
                raw = raw.strip()
                if not raw:
                    continue
                steps.append(validate_line(json.loads(raw), lineno, path))
    return steps


class ShardDataset(Dataset):
    def __init__(self, steps):
        self.steps = steps

    def __len__(self):
        return len(self.steps)

    def __getitem__(self, i):
        return self.steps[i]


def collate(batch):
    t_max = max(len(s["tok_ids"]) for s in batch)
    out = {
        "tok_ids": [],
        "field_hash": [],
        "name_hash": [],
        "menu_mask": [],
        "gold_pos": [],
        "domain": [],
        "menu_actions": [],
    }
    for s in batch:
        pad = t_max - len(s["tok_ids"])
        out["tok_ids"].append(s["tok_ids"] + [0] * pad)
        out["field_hash"].append(s["field_hash"] + [0] * pad)
        out["name_hash"].append(s["name_hash"] + [0] * pad)
        out["menu_mask"].append(s["menu_mask"] + [False] * pad)
        out["gold_pos"].append(s["gold_pos"])
        out["domain"].append(s["domain"])
        out["menu_actions"].append(s["menu_actions"])
    return {
        "tok_ids": torch.tensor(out["tok_ids"], dtype=torch.long),
        "field_hash": torch.tensor(out["field_hash"], dtype=torch.long),
        "name_hash": torch.tensor(out["name_hash"], dtype=torch.long),
        "menu_mask": torch.tensor(out["menu_mask"], dtype=torch.bool),
        "gold_pos": torch.tensor(out["gold_pos"], dtype=torch.long),
        "domain": out["domain"],
        "menu_actions": out["menu_actions"],
    }


def split_by_recipe(steps, val_frac=0.1, seed=7):
    """Split steps into train/val by recipe_id so no episode leaks across."""
    import random

    recipes = sorted({s["recipe_id"] for s in steps})
    rng = random.Random(seed)
    rng.shuffle(recipes)
    n_val = max(1, int(len(recipes) * val_frac))
    val_ids = set(recipes[:n_val])
    val = [s for s in steps if s["recipe_id"] in val_ids]
    train = [s for s in steps if s["recipe_id"] not in val_ids]
    return train, val
