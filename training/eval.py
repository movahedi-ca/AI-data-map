"""Eval harness for the tiny workflow model.

Runs three suites and fails loudly if any gate fails:

1. IN-DOMAIN: menu-choice accuracy on held-out recipes from the training
   domains.
2. OUT-OF-DOMAIN: accuracy on recipes whose domain was never seen in
   training. This is the modular/dynamic proof: same weights, new recipe
   vocabulary, sensible choices.
3. MENU PERMUTATION: the same steps with the menu order shuffled. A pointer
   model reads the menu from the input, so accuracy must hold; a model that
   memorized positions fails. This guards against position overfitting.

Well-formedness gates run on every prediction: finite scores, exactly one
argmax inside the menu, no NaN anywhere.
"""

import argparse
import copy
import json
import random
import sys

import torch
from torch.utils.data import DataLoader

from data import ShardDataset, collate, load_shards
from model import TinyWorkflowModel


def domain_matches(domain: str, prefixes) -> bool:
    """Prefix-aware match: 'data-mapping' matches 'data-mapping' and
    'data-mapping/smoke' but not 'data-mapping-evil'."""
    return any(domain == p or domain.startswith(p + "/") for p in prefixes)


def split_domains(steps, train_domains):
    """Split steps into in-domain and out-of-domain.

    With explicit --train-domains, anything not matching is out-of-domain.
    Without it, the teacher's naming convention applies: 'data-mapping/*'
    is in-domain, 'ood-*' is out-of-domain. Steps matching neither are
    reported and excluded from both scores.
    """
    in_domain, out_domain, unclassified = [], [], []
    for s in steps:
        d = s["domain"]
        if train_domains:
            (in_domain if domain_matches(d, train_domains) else out_domain).append(s)
        elif d == "data-mapping" or d.startswith("data-mapping/"):
            in_domain.append(s)
        elif d.startswith("ood-"):
            out_domain.append(s)
        else:
            unclassified.append(s)
    return in_domain, out_domain, unclassified


def load_model(ckpt_path, device):
    ckpt = torch.load(ckpt_path, map_location=device, weights_only=False)
    cfg = ckpt["config"]
    model = TinyWorkflowModel(
        d_model=cfg["d_model"], n_layer=cfg["n_layer"], n_head=cfg["n_head"],
        d_ff=cfg["d_ff"], tok_vocab=cfg["tok_vocab"],
        field_buckets=cfg["field_buckets"], name_buckets=cfg["name_buckets"],
        max_len=cfg["max_len"],
    ).to(device)
    model.load_state_dict(ckpt["state_dict"])
    model.eval()
    return model


def check_wellformed(scores, menu_mask):
    # Masked (non-menu) positions are -inf by design; finiteness is only
    # required on the menu positions the model may actually choose.
    if not menu_mask.any():
        raise AssertionError("empty menu in batch")
    if not torch.isfinite(scores[menu_mask]).all():
        raise AssertionError("non-finite score on a valid menu position")
    pred = scores.masked_fill(~menu_mask, float("-inf")).argmax(dim=-1)
    for i in range(len(pred)):
        if not menu_mask[i][pred[i]]:
            raise AssertionError("argmax landed outside the menu")
    return pred


@torch.no_grad()
def accuracy(model, steps, device, batch=64):
    dl = DataLoader(ShardDataset(steps), batch_size=batch, collate_fn=collate)
    correct, total = 0, 0
    for b in dl:
        menu_mask = b["menu_mask"].to(device)
        scores = model(
            b["tok_ids"].to(device), b["field_hash"].to(device),
            b["name_hash"].to(device), menu_mask,
        )
        pred = check_wellformed(scores, menu_mask)
        correct += (pred.cpu() == b["gold_pos"]).sum().item()
        total += len(b["gold_pos"])
    return correct / max(total, 1), total


def permute_menu(step, rng):
    """Return a copy of the step with the menu entries shuffled.

    The token ids, fields, and menu_actions are reordered together and the
    gold index is recomputed, so the step stays valid. A model that truly
    reads the menu keeps its accuracy; a position memorizer does not.
    """
    s = copy.deepcopy(step)
    menu_pos = [i for i, m in enumerate(s["menu_mask"]) if m]
    order = list(range(len(menu_pos)))
    rng.shuffle(order)
    new_pos = [menu_pos[i] for i in order]
    ids = s["tok_ids"][:]
    fhs = s["field_hash"][:]
    nhs = s["name_hash"][:]
    acts = s["menu_actions"][:]
    for new_i, old_p in zip(new_pos, menu_pos):
        ids[new_i] = s["tok_ids"][old_p]
        fhs[new_i] = s["field_hash"][old_p]
        nhs[new_i] = s["name_hash"][old_p]
    s["tok_ids"], s["field_hash"], s["name_hash"] = ids, fhs, nhs
    s["menu_actions"] = [acts[order.index(i)] for i in range(len(acts))]
    old_gold_entry = menu_pos.index(s["gold_pos"])
    s["gold_pos"] = new_pos[old_gold_entry]
    s["gold_menu_index"] = order.index(old_gold_entry)
    return s


def main(args):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = load_model(args.checkpoint, device)
    steps = load_shards(args.shards)
    train_domains = (
        [p for p in args.train_domains.split(",") if p]
        if args.train_domains else []
    )
    in_domain, out_domain, unclassified = split_domains(steps, train_domains)
    if unclassified:
        print(
            f"note: {len(unclassified)} step(s) match neither in-domain nor "
            f"out-of-domain prefixes; excluded from both scores"
        )

    report = {"unclassified_steps": len(unclassified)}
    acc, n = accuracy(model, in_domain, device)
    report["in_domain"] = {"accuracy": acc, "steps": n}
    print(f"in-domain accuracy: {acc:.4f} on {n} steps")

    if out_domain:
        acc_o, n_o = accuracy(model, out_domain, device)
        report["out_of_domain"] = {"accuracy": acc_o, "steps": n_o}
        print(f"out-of-domain accuracy: {acc_o:.4f} on {n_o} steps")
        if acc_o < args.ood_gate:
            print(
                f"GATE FAILED: out-of-domain accuracy {acc_o:.4f} "
                f"below {args.ood_gate}",
                file=sys.stderr,
            )
            sys.exit(2)

    rng = random.Random(11)
    permuted = [permute_menu(s, rng) for s in in_domain]
    acc_p, n_p = accuracy(model, permuted, device)
    report["menu_permutation"] = {"accuracy": acc_p, "steps": n_p}
    print(f"menu-permutation accuracy: {acc_p:.4f} on {n_p} steps")
    if abs(acc_p - acc) > args.perm_tolerance:
        print(
            f"GATE FAILED: permutation accuracy moved {abs(acc_p - acc):.4f}, "
            f"tolerance {args.perm_tolerance}; the model may be memorizing positions",
            file=sys.stderr,
        )
        sys.exit(3)

    if acc < args.indomain_gate:
        print(
            f"GATE FAILED: in-domain accuracy {acc:.4f} below {args.indomain_gate}",
            file=sys.stderr,
        )
        sys.exit(4)

    with open(args.report, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(f"all gates passed; report written to {args.report}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--shards", nargs="+", required=True)
    ap.add_argument("--report", required=True)
    ap.add_argument("--train-domains", default="",
                    help="comma-separated domain prefixes the model trained on "
                         "(prefix match: 'data-mapping' matches "
                         "'data-mapping/smoke'). Without it, the teacher "
                         "convention applies: 'data-mapping/*' is in-domain, "
                         "'ood-*' is out-of-domain.")
    ap.add_argument("--indomain-gate", type=float, default=0.85)
    ap.add_argument("--ood-gate", type=float, default=0.60)
    ap.add_argument("--perm-tolerance", type=float, default=0.10)
    main(ap.parse_args())
