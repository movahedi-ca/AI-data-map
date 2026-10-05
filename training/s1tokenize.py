"""Tokenization helpers for the System-1 workflow model.

Named s1tokenize (not tokenize) because the stdlib has a tokenize module
and shadowing it breaks torch's own imports.

The frozen specs/token-schema.json defines the input language: 16-bit token
ids plus per-token field objects. This module turns a shard line into model
tensors. It implements no learning; it is pure encoding.
"""

import hashlib
import json

# Frozen id ranges from specs/token-schema.json (encoding_version 1.0.0).
BOS, EOS = 0, 1
SNAPSHOT_SEP, ANNOT_SEP, MENU_SEP = 2, 3, 4
NODE_LO, NODE_HI = 32, 96
EDGE_LO, EDGE_HI = 96, 160
ANNOT_LO, ANNOT_HI = 160, 224
MENU_LO, MENU_HI = 224, 288


def stable_hash(text: str, buckets: int) -> int:
    """Deterministic string hash into [0, buckets). Same input, same output,
    across processes and machines. Used so field objects and action names get
    stable embeddings without a fixed vocabulary."""
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % buckets


def canonical_fields(field_obj) -> str:
    """Canonical JSON for a field object: sorted keys, no whitespace."""
    return json.dumps(field_obj, sort_keys=True, separators=(",", ":"))


def encode_step(input_ids, fields, field_buckets=4096, name_buckets=1024):
    """Encode one labeled step into integer arrays.

    Returns a dict with:
      tok_ids:   list[int], the raw token ids (clamped by the model to its vocab)
      field_hash: list[int], stable hash of each token's canonical field JSON
      name_hash: list[int], stable hash of the action_name for menu tokens,
                 0 for every other token
      menu_mask: list[bool], True exactly on action-menu token positions
    """
    if len(input_ids) != len(fields):
        raise ValueError(
            f"input_ids ({len(input_ids)}) and fields ({len(fields)}) differ in length"
        )
    tok_ids, field_hash, name_hash, menu_mask = [], [], [], []
    for tid, f in zip(input_ids, fields):
        if not isinstance(tid, int) or not (0 <= tid <= 65535):
            raise ValueError(f"token id out of range: {tid!r}")
        try:
            fobj = json.loads(f)
        except json.JSONDecodeError as exc:
            raise ValueError(f"field entry is not JSON: {f!r}") from exc
        tok_ids.append(tid)
        field_hash.append(stable_hash(canonical_fields(fobj), field_buckets))
        is_menu = MENU_LO <= tid < MENU_HI
        menu_mask.append(is_menu)
        if is_menu:
            name = fobj.get("action_name")
            if not isinstance(name, str) or not name:
                raise ValueError(f"menu token missing action_name: {f!r}")
            name_hash.append(stable_hash(name, name_buckets))
        else:
            name_hash.append(0)
    if not any(menu_mask):
        raise ValueError("step has an empty action menu")
    return {
        "tok_ids": tok_ids,
        "field_hash": field_hash,
        "name_hash": name_hash,
        "menu_mask": menu_mask,
    }
