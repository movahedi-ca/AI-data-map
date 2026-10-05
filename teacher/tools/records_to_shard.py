#!/usr/bin/env python3
"""records_to_shard.py - convert teacher recorder JSONL to SHARD-FORMAT 1.0.0.

Reads one recorder shard (<shard>.jsonl + <shard>.manifest.json, as written
by teacher/lib/recorder.mjs) and emits SHARD-FORMAT 1.0.0 JSONL lines, one
per record, suitable for training/data.py.

Mapping (all deterministic, no timestamps in the output lines):
- step k input state = snapshot_before for k=0, else snapshot_after of k-1.
- domain: manifest domain normalized to the eval convention:
  "data-mapping" -> "data-mapping/<shard>", "ood-*" kept as-is.
- nodes: 32 + slot, slot = position in numeric node-id sort order.
  fields: {node_id, type (enum int), x, y (rounded half up), label}.
- edges: 96 + slot, slot = position in (a_slot, b_slot, cat_alpha) sort.
  fields: {a, b (node slots), cat (enum int)}.
- annotations: 160 + slot, slot = position in (node_slot, kind, payload)
  sort. fields: {node_slot, kind (enum int), payload}. node_slot is the
  slot of the annotation's node_id; a null node_id uses the union rule
  (next free slot), per SHARD-FORMAT.md.
- menu: 224 + j in menu_before order.
  fields: {action_name, params_digest} where params_digest is the first
  8 hex chars of sha256(canonical JSON of the menu params).
- gold_menu_index: the menu_before entry whose (action_name, params)
  equals the recorded action. Loud failure on no match or ambiguity.

Usage:
  python3 records_to_shard.py <shard.jsonl> <shard.manifest.json> <out.jsonl>
"""

import hashlib
import json
import re
import sys
from decimal import Decimal, ROUND_HALF_UP

BOS, EOS = 0, 1
SNAPSHOT_SEP, ANNOT_SEP, MENU_SEP = 2, 3, 4
NODE_LO, EDGE_LO, ANNOT_LO, MENU_LO = 32, 96, 160, 224

NODE_TYPES = {"collection": 0, "system": 1, "thirdparty": 2, "destruction": 3}
EDGE_CATS = {"contact": 0, "payment": 1, "marketing": 2}
ANNOT_KINDS = {"retention": 0, "confirmation": 1, "review_flag": 2}
NODE_ID_RE = re.compile(r"^n([1-9]\d*)$")


def node_num(nid):
    m = NODE_ID_RE.match(nid)
    if not m:
        raise ValueError(f"bad node id: {nid!r}")
    return int(m.group(1))


def round_half_up(v):
    return int(Decimal(str(v)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def digest8(obj):
    return hashlib.sha256(canonical(obj).encode("utf-8")).hexdigest()[:8]


def normalize_domain(domain, shard):
    if domain == "data-mapping":
        return "data-mapping/" + shard
    return domain


def convert(records, manifest, shard_name):
    domain = normalize_domain(manifest["domain"], shard_name)
    recipe_id = manifest["recipe_id"]
    out_lines = []
    prev_after = None
    for rec in records:
        k = rec["step"]
        state = rec["snapshot_before"] if k == 0 else prev_after
        if state is None:
            raise ValueError(f"step {k}: missing pre-action state")
        prev_after = rec["snapshot_after"]

        nodes = state["canvas"]["nodes"]
        order = sorted(nodes.keys(), key=node_num)
        slot_of = {nid: i for i, nid in enumerate(order)}

        ids, fields = [BOS], ["{}"]
        for i, nid in enumerate(order):
            n = nodes[nid]
            if n["type"] not in NODE_TYPES:
                raise ValueError(f"step {k}: unknown node type {n['type']!r}")
            ids.append(NODE_LO + i)
            fields.append(canonical({
                "node_id": nid,
                "type": NODE_TYPES[n["type"]],
                "x": round_half_up(n["x"]),
                "y": round_half_up(n["y"]),
                "label": n["label"],
            }))

        ids.append(SNAPSHOT_SEP)
        fields.append("{}")
        edge_keys = []
        for e in state["canvas"]["edges"]:
            a, b = slot_of[e["a"]], slot_of[e["b"]]
            edge_keys.append((a, b, e["cat"]))
        edge_keys.sort(key=lambda t: (t[0], t[1], t[2]))
        for i, (a, b, cat) in enumerate(edge_keys):
            if cat not in EDGE_CATS:
                raise ValueError(f"step {k}: unknown edge cat {cat!r}")
            ids.append(EDGE_LO + i)
            fields.append(canonical({"a": a, "b": b, "cat": EDGE_CATS[cat]}))

        ids.append(ANNOT_SEP)
        fields.append("{}")
        annot_keys = []
        for a in state.get("annotations", []):
            nid = a.get("node_id")
            nslot = slot_of[nid] if nid in slot_of else len(order)
            kind = ANNOT_KINDS[a["kind"]]
            annot_keys.append((nslot, kind, canonical(a["payload"])))
        annot_keys.sort(key=lambda t: (t[0], t[1], t[2]))
        for i, (nslot, kind, payload_canon) in enumerate(annot_keys):
            ids.append(ANNOT_LO + i)
            fields.append(canonical({
                "node_slot": nslot,
                "kind": kind,
                "payload": json.loads(payload_canon),
            }))

        ids.append(MENU_SEP)
        fields.append("{}")
        menu = rec["menu_before"]
        menu_actions = []
        for j, m in enumerate(menu):
            ids.append(MENU_LO + j)
            fields.append(canonical({
                "action_name": m["action_name"],
                "params_digest": digest8(m.get("params", {})),
            }))
            menu_actions.append(m["action_name"])

        act = rec["action"]
        act_name = act["action_id"].split(":")[0]
        act_params_canon = canonical(act.get("params", {}))
        gold = None
        for j, m in enumerate(menu):
            if m["action_name"] == act_name and canonical(m.get("params", {})) == act_params_canon:
                if gold is not None:
                    raise ValueError(f"step {k}: ambiguous gold match for {act['action_id']}")
                gold = j
        if gold is None:
            # Some actions are unparameterized in the menu (flag_for_review,
            # undo_last, abort_session carry params: {} there) while the
            # recorded action carries the teacher's params. Fall back to a
            # name-only match, requiring uniqueness.
            name_hits = [j for j, m in enumerate(menu) if m["action_name"] == act_name]
            if len(name_hits) == 1:
                gold = name_hits[0]
            elif len(name_hits) == 0:
                raise ValueError(f"step {k}: no menu match for action {act['action_id']}")
            else:
                raise ValueError(f"step {k}: ambiguous name-only match for {act['action_id']}")

        ids.append(EOS)
        fields.append("{}")
        out_lines.append({
            "shard_format": "1.0.0",
            "recipe_id": recipe_id,
            "domain": domain,
            "step_index": k,
            "input_ids": ids,
            "fields": fields,
            "menu_actions": menu_actions,
            "gold_menu_index": gold,
        })
    return out_lines


def main(argv):
    jsonl_path, manifest_path, out_path = argv[1], argv[2], argv[3]
    manifest = json.load(open(manifest_path, encoding="utf-8"))
    records = []
    with open(jsonl_path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    shard_name = manifest.get("shard", "unknown")
    out_lines = convert(records, manifest, shard_name)
    with open(out_path, "w", encoding="utf-8") as fh:
        for ln in out_lines:
            fh.write(canonical(ln) + "\n")
    print(f"converted {len(out_lines)} steps -> {out_path}")


if __name__ == "__main__":
    main(sys.argv)
