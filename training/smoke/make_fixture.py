"""Build a tiny synthetic fixture in the teacher shard format.

Two domains, following the teacher's naming convention:
- "data-mapping/smoke": uses the frozen action names (add_node, connect,
  export, set_field) and the frozen node/edge token layout.
- "ood-taskflow": a synthetic other domain with different action names
  (add_task, link_tasks, mark_done). Same token grammar, new vocabulary.
  This is what lets the smoke test exercise the out-of-domain path:
  the model is trained on data-mapping steps and evaluated on ood steps
  with the same weights.

The gold policy is a fixed scripted rule in both domains, so the pattern
is learnable: link/connect when two items exist but are unlinked, add when
fewer than three items exist, finish otherwise.
"""

import argparse
import json
import random

from s1tokenize import canonical_fields

BOS, EOS = 0, 1
SNAPSHOT_SEP, ANNOT_SEP, MENU_SEP = 2, 3, 4


def menu_token(action_name, params_digest="d0"):
    return 224, {"action_name": action_name, "params_digest": params_digest}


def build_step(rng, domain, step_index, recipe_id):
    if domain == "data-mapping/smoke":
        actions = ["add_node", "connect", "export", "set_field"]
        n_items = rng.randint(1, 4)
        linked = rng.random() < 0.5 and n_items >= 2
        labels = ["Intake form", "CRM", "Email vendor", "Archive"]
        types = [0, 1, 2, 3]
    else:
        actions = ["add_task", "link_tasks", "mark_done"]
        n_items = rng.randint(1, 4)
        linked = rng.random() < 0.5 and n_items >= 2
        labels = ["Write brief", "Review", "Publish", "Follow up"]
        types = [0, 1, 0, 1]

    ids, fields = [BOS], ["{}"]
    for i in range(n_items):
        ids.append(32 + i)
        fields.append(canonical_fields({
            "node_id": f"n{i + 1}",
            "type": types[i % len(types)],
            "x": 80 + i * 120,
            "y": 80 + (i % 2) * 120,
            "label": labels[i % len(labels)],
        }))
    ids.append(SNAPSHOT_SEP)
    fields.append("{}")
    if linked:
        ids.append(96)
        fields.append(canonical_fields({"a": 0, "b": 1, "cat": 0}))
    ids.append(ANNOT_SEP)
    fields.append("{}")
    # Annotation anchor exercise: half the steps carry a flag annotation.
    # Sometimes it anchors on the union slot of a not-yet-built node
    # (node_slot == n_items, no node token), which the loader must accept
    # per the SHARD-FORMAT.md union rule.
    if rng.random() < 0.5:
        anchor_future = rng.random() < 0.3
        ids.append(160)
        fields.append(canonical_fields({
            "node_slot": n_items if anchor_future else 0,
            "kind": "flag",
            "payload": "review",
        }))
    ids.append(MENU_SEP)
    fields.append("{}")
    menu_ids = []
    for j, a in enumerate(actions):
        tid, fobj = 224 + j, {"action_name": a, "params_digest": f"d{j}"}
        ids.append(tid)
        fields.append(canonical_fields(fobj))
        menu_ids.append(tid)
    ids.append(EOS)
    fields.append("{}")

    if domain == "data-mapping/smoke":
        if n_items >= 2 and not linked:
            gold = actions.index("connect")
        elif n_items < 3:
            gold = actions.index("add_node")
        else:
            gold = actions.index("export")
    else:
        if n_items >= 2 and not linked:
            gold = actions.index("link_tasks")
        elif n_items < 3:
            gold = actions.index("add_task")
        else:
            gold = actions.index("mark_done")

    return {
        "shard_format": "1.0.0",
        "recipe_id": recipe_id,
        "domain": domain,
        "step_index": step_index,
        "input_ids": ids,
        "fields": fields,
        "menu_actions": actions,
        "gold_menu_index": gold,
    }


def main(args):
    rng = random.Random(args.seed)
    steps = []
    n = 0
    for r in range(args.recipes_per_domain):
        for domain in ("data-mapping/smoke", "ood-taskflow"):
            recipe_id = f"smoke-{domain}-{r}"
            for s in range(args.steps_per_recipe):
                steps.append(build_step(rng, domain, s, recipe_id))
                n += 1
    with open(args.out, "w", encoding="utf-8") as fh:
        for st in steps:
            fh.write(json.dumps(st) + "\n")
    print(f"wrote {n} steps to {args.out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--recipes-per-domain", type=int, default=8)
    ap.add_argument("--steps-per-recipe", type=int, default=4)
    ap.add_argument("--seed", type=int, default=7)
    main(ap.parse_args())
