"""Tiny workflow-execution model (System-1 reflex).

Architecture: a small transformer encoder reads the tokenized state plus the
valid-action menu, then a pointer head scores each menu position. The output
is a distribution over menu slots, not over a fixed action list.

Why this is modular and dynamic (the binding requirement): the action names
arrive inside the input, as menu token fields, and are embedded through a
stable string hash. The model never sees a fixed output class list. The same
weights can therefore serve a new domain with new action names: the new
recipe's menu is read from the input, and the pointer picks among the entries
it is actually given. Out-of-domain reuse is a structural property of the
architecture, and eval.py measures it.

Input tensors (all shape (B, T) except where noted):
  tok_ids:    long, raw token ids from the frozen schema
  field_hash: long, stable hash bucket of each token's canonical field JSON
  name_hash:  long, stable hash bucket of the action_name on menu tokens,
              0 elsewhere
  menu_mask:  bool, True exactly on action-menu token positions

Output: menu_scores, shape (B, T), -inf on non-menu positions. argmax over
the valid positions is the chosen menu entry.
"""

import math

import torch
import torch.nn as nn


class TinyWorkflowModel(nn.Module):
    def __init__(
        self,
        d_model=128,
        n_layer=4,
        n_head=4,
        d_ff=256,
        dropout=0.1,
        tok_vocab=1024,
        field_buckets=4096,
        name_buckets=1024,
        max_len=512,
    ):
        super().__init__()
        self.d_model = d_model
        self.max_len = max_len
        # The frozen schema uses ids 0..287; 1024 leaves headroom. If a later
        # encoding version uses ids past tok_vocab-1, bump tok_vocab and
        # retrain; ids are clamped, never wrapped.
        self.tok_emb = nn.Embedding(tok_vocab, d_model)
        self.field_emb = nn.Embedding(field_buckets, d_model)
        self.name_emb = nn.Embedding(name_buckets, d_model)
        self.pos_emb = nn.Embedding(max_len, d_model)
        layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=n_head,
            dim_feedforward=d_ff,
            dropout=dropout,
            batch_first=True,
        )
        self.encoder = nn.TransformerEncoder(layer, num_layers=n_layer)
        self.pointer = nn.Linear(d_model, 1)
        self.drop = nn.Dropout(dropout)

    def forward(self, tok_ids, field_hash, name_hash, menu_mask):
        b, t = tok_ids.shape
        if t > self.max_len:
            raise ValueError(f"sequence length {t} exceeds max_len {self.max_len}")
        tok_ids = tok_ids.clamp(max=self.tok_emb.num_embeddings - 1)
        pos = torch.arange(t, device=tok_ids.device).unsqueeze(0).expand(b, t)
        menu_f = menu_mask.to(tok_ids.dtype).unsqueeze(-1)
        x = (
            self.tok_emb(tok_ids)
            + self.field_emb(field_hash)
            + self.name_emb(name_hash) * menu_f
            + self.pos_emb(pos)
        )
        x = self.drop(x)
        h = self.encoder(x)
        scores = self.pointer(h).squeeze(-1)
        scores = scores.masked_fill(~menu_mask, float("-inf"))
        return scores

    def predict(self, tok_ids, field_hash, name_hash, menu_mask):
        """Return the chosen menu slot index per batch row (index into the
        full sequence; callers map it back to a menu entry)."""
        with torch.no_grad():
            scores = self.forward(tok_ids, field_hash, name_hash, menu_mask)
            return scores.argmax(dim=-1)


def count_params(model) -> int:
    return sum(p.numel() for p in model.parameters())


def model_config_dict(model: TinyWorkflowModel) -> dict:
    return {
        "d_model": model.d_model,
        "n_layer": len(model.encoder.layers),
        "n_head": model.encoder.layers[0].self_attn.num_heads,
        "d_ff": model.encoder.layers[0].linear1.out_features,
        "tok_vocab": model.tok_emb.num_embeddings,
        "field_buckets": model.field_emb.num_embeddings,
        "name_buckets": model.name_emb.num_embeddings,
        "max_len": model.max_len,
        "params": count_params(model),
        "encoding_version": "1.0.0",
    }
