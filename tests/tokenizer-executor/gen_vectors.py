#!/usr/bin/env python3
"""Generate tokenizer parity vectors for tokenizer-parity.test.js.

Uses training/s1tokenize.py (the reference implementation, stdlib only:
hashlib, json) to produce expected outputs. The Node test runs the JS port
(web/executor/js/s1tokenize.js) over the same inputs and asserts
byte-identical results.

Regenerate with: python3 gen_vectors.py
Outputs: vectors.json (handcrafted), fuzz_vectors.json (200 seeded random).

Known input classes are deliberately EXCLUDED from parity because the two
implementations intentionally diverge (documented in the test file):
  - bool token ids: Python treats True as int 1; JS rejects non-numbers.
  - non-string field entries: Python raises TypeError; JS raises ValueError.
  - lone surrogates in strings: Python utf-8 encode raises; JS TextEncoder
    substitutes U+FFFD.
  - single quotes inside field text on ERROR paths: Python repr() switches to
    double quotes; the JS pyRepr always single-quotes.
"""

import json
import os
import random
import sys

sys.path.insert(0, "/tmp/tests-build/training")
import s1tokenize as T

OUT = os.path.dirname(os.path.abspath(__file__))


def record_ok(vid, ids, fields):
    out = T.encode_step(ids, fields)
    return {
        "id": vid, "ids": ids, "fields": fields, "ok": True,
        "expected": {
            "tok_ids": out["tok_ids"],
            "field_hash": out["field_hash"],
            "name_hash": out["name_hash"],
            "menu_mask": out["menu_mask"],
        },
    }


def record_err(vid, ids, fields):
    try:
        T.encode_step(ids, fields)
    except Exception as e:  # noqa: BLE001 - we record whatever Python raises
        return {
            "id": vid, "ids": ids, "fields": fields, "ok": False,
            "error": {"name": type(e).__name__, "message": str(e)},
        }
    return {"id": vid, "ids": ids, "fields": fields, "ok": False,
            "error": {"name": "NO_ERROR", "message": "expected an error"}}


def jse(obj, **kw):
    """JSON field text with controllable separators/ensure_ascii."""
    return json.dumps(obj, **kw)


vectors = []
V = vectors.append

# ---------------------------------------------------------------- A: structure
V(record_ok("minimal", [224], ['{"action_name":"add_node"}']))
V(record_ok("bos-menu-eos", [0, 224, 1],
            ['{}', '{"action_name":"x"}', '{}']))
V(record_ok("full-realistic",
            [0, 32, 33, 2, 96, 3, 160, 4, 224, 225, 1],
            ['{}',
             '{"node_id":"n1","type":1,"x":100,"y":120,"label":"CRM"}',
             '{"label":"Site Web","node_id":"n2","type":0,"x":200.5,"y":80,"extra":null}',
             '{}',
             '{"a":0,"b":1,"cat":2}',
             '{}',
             '{"kind":1,"node_slot":0,"payload":{"note":"ok"}}',
             '{}',
             '{"action_name":"add_node","params_digest":"abcdef12"}',
             '{"params_digest":"00112233","action_name":"skip_recipe_item"}',
             '{}']))
V(record_ok("id-boundaries",
            [0, 1, 2, 3, 4, 32, 95, 96, 159, 160, 223, 224, 287, 288, 65535],
            ['{}', '{}', '{}', '{}', '{}',
             '{"node_id":"n1"}', '{"node_id":"n64"}',
             '{"a":0}', '{"a":63}', '{"k":0}', '{"k":63}',
             '{"action_name":"first"}', '{"action_name":"last"}',
             '{"plain":"non-menu"}', '{"plain":"max-id"}']))
menu64_ids = [4] + list(range(224, 288)) + [1]
V(record_ok("menu-64-max",
            menu64_ids,
            ['{}'] + ['{"action_name":"action_%02d"}' % i for i in range(64)] + ['{}']))
V(record_ok("duplicate-menu-entries", [224, 225, 226],
            ['{"action_name":"connect","params_digest":"aa"}',
             '{"action_name":"connect","params_digest":"bb"}',
             '{"action_name":"connect","params_digest":"aa"}']))
V(record_ok("menu-boundary-224-only", [224], ['{"action_name":"edge"}']))
V(record_ok("menu-boundary-287-only", [0, 287, 1],
            ['{}', '{"action_name":"edge"}', '{}']))
V(record_ok("nonmenu-223-288", [223, 224, 288],
            ['{"x":1}', '{"action_name":"m"}', '{"x":2}']))
V(record_ok("menu-field-minimal", [224], ['{"action_name":"a"}']))
V(record_ok("menu-field-extra", [224],
            ['{"action_name":"x","params_digest":"ab","zzz":[1,{"q":null}],"n":3.5}']))
V(record_ok("action-name-ignored-offmenu", [32, 224],
            ['{"action_name":"ignored-here"}', '{"action_name":"used"}']))
stress_ids = [0]
stress_fields = ['{}']
tid_pool = ([32, 40, 95] + [96, 120, 159] + [160, 200, 223]
            + [2, 3, 4] + [1000, 60000])
for i in range(120):
    t = tid_pool[i % len(tid_pool)]
    stress_ids.append(t)
    stress_fields.append('{"i":%d,"s":"tok%d"}' % (i, i))
stress_ids += [4, 224, 225, 226, 1]
stress_fields += ['{}', '{"action_name":"m1"}', '{"action_name":"m2"}',
                  '{"action_name":"m3"}', '{}']
V(record_ok("stress-129-tokens", stress_ids, stress_fields))

# ------------------------------------------------- B: field object shapes
V(record_ok("nested-deep",
            [32, 224],
            [jse({"a": {"b": {"c": [1, 2.5, "x", None, True, {"k": "v"}]}}}),
             '{"action_name":"n"}']))
V(record_ok("unsorted-keys", [33, 224],
            ['{"z":1,"a":2,"m":3,"b":{"y":1,"x":2}}', '{"action_name":"n"}']))
V(record_ok("unicode-keys", [34, 224],
            [jse({"é": 1, "中": 2, "🎉": 3, "plain": 4}), '{"action_name":"n"}']))
V(record_ok("key-order-astral-vs-bmp", [35, 224],
            [jse({"z": 1, "é": 2, "": 3, "😀": 4, "中": 5, "a": 6}),
             '{"action_name":"n"}']))
V(record_ok("empty-containers", [36, 224],
            ['{"a":[],"o":{},"s":""}', '{"action_name":"n"}']))
V(record_ok("ints", [37, 224],
            [jse({"big": 10 ** 40, "neg": -7, "zero": 0, "u16": 65535,
                  "negzero_lit": 0}),
             '{"action_name":"n"}']))
V(record_ok("int-float-distinct", [38, 224],
            ['{"as_int":40,"as_float":40.0}', '{"action_name":"n"}']))
V(record_ok("floats", [39, 224],
            [jse({"a": 0.0, "b": 0.1, "c": 1e-4, "d": 1e-5, "e": 1e15,
                  "f": 1e16, "g": 1.5e-7, "h": 123.456789, "i": 1e+51,
                  "j": 2.5, "k": -3.25, "l": 0.30000000000000004,
                  "m": 9999999999999998.0}),
             '{"action_name":"n"}']))
V(record_ok("neg-zero-float", [40, 224], ['{"v":-0.0}', '{"action_name":"n"}']))
V(record_ok("nan-inf-literals", [41, 224],
            ['{"a":NaN,"b":Infinity,"c":-Infinity}', '{"action_name":"n"}']))
V(record_ok("escapes", [42, 224],
            [jse({"q": 'a"b\\c', "nl": "x\ny", "tab": "p\tq", "cr": "r\rs",
                  "bs": "s\x08s", "ff": "t\x0cu", "ctl": "\x01\x02"}),
             '{"action_name":"n"}']))
V(record_ok("del-and-c0", [43, 224],
            ['{"d":"\\u007f","c":"\\u0001"}', '{"action_name":"n"}']))
V(record_ok("astral-values", [44, 224],
            [jse({"emoji": "🎉🇨🇦", "music": "𝄞", "mixed": "a🎉b"}),
             '{"action_name":"n"}']))
V(record_ok("long-strings", [45, 224],
            [jse({"label": "L" * 200, "blob": "x" * 5000, "name": "n" * 300}),
             jse({"action_name": "a" * 300})]))
V(record_ok("ws-variant-a", [46, 224],
            ['{  "b" : 1 , "a" : [ 1 , 2 ] }', '{"action_name":"n"}']))
V(record_ok("ws-variant-b", [46, 224],
            ['{"a":[1,2],"b":1}', '{"action_name":"n"}']))
V(record_ok("escape-vs-literal-e9-a", [47, 224],
            ['{"city":"Montr\\u00e9al"}', '{"action_name":"n"}']))
V(record_ok("escape-vs-literal-e9-b", [47, 224],
            [jse({"city": "Montréal"}), '{"action_name":"n"}']))
V(record_ok("ensure-ascii-vs-raw-a", [48, 224],
            [jse({"city": "Québec 日本"}, ensure_ascii=True), '{"action_name":"n"}']))
V(record_ok("ensure-ascii-vs-raw-b", [48, 224],
            [jse({"city": "Québec 日本"}, ensure_ascii=False), '{"action_name":"n"}']))
V(record_ok("duplicate-keys-last-wins", [49, 224],
            ['{"a":1,"a":2}', '{"action_name":"n"}']))
V(record_ok("numeric-string-keys", [50, 224],
            ['{"10":"a","2":"b","1":"c"}', '{"action_name":"n"}']))
V(record_ok("uppercase-exponent", [51, 224],
            ['{"v":1E-5,"w":2.5E+3}', '{"action_name":"n"}']))
V(record_ok("neg-zero-int-literal", [52, 224],
            ['{"v":-0}', '{"action_name":"n"}']))
V(record_ok("huge-int-literal", [53, 224],
            ['{"v":12345678901234567890123456789012345678901234567890}',
             '{"action_name":"n"}']))
V(record_ok("all-short-escapes", [54, 224],
            ['{"s":"\\"\\\\\\/\\b\\f\\n\\r\\t"}', '{"action_name":"n"}']))
V(record_ok("deep-arrays", [55, 224],
            ['{"m":[[[1]],[],[2,[3,[4]]]]}', '{"action_name":"n"}']))
V(record_ok("retention-payload", [160, 224],
            [jse({"kind": 0, "node_slot": 2,
                  "payload": {"record_type": "invoices", "range_min_years": 2,
                              "range_max_years": 7,
                              "statute": "Tax Act s. 230(4)",
                              "as_of": "2020-01-15"}}),
             '{"action_name":"set_retention"}']))
V(record_ok("review-flag-payload", [161, 224],
            [jse({"kind": 2, "node_slot": 0,
                  "payload": {"reason": "needs a human look", "item_index": 3}}),
             '{"action_name":"flag_for_review"}']))
V(record_ok("unicode-labels", [32, 33, 224],
            [jse({"node_id": "n1", "label": "Données clients 🎉"}),
             jse({"node_id": "n2", "label": "مشتریان"}),
             jse({"action_name": "confirmer_nœud"})]))

# ------------------------------------------------- C: action names
V(record_ok("unicode-action-names",
            [224, 225, 226, 227, 228],
            [jse({"action_name": n}) for n in
             ["ajouter_nœud", "添加节点", "add_node_🎉", "گره", "nodo_日本語"]]))
V(record_ok("special-char-action-names",
            [224, 225, 226, 227, 228, 229],
            [jse({"action_name": n}) for n in
             ["a-b_c.d:e/f", "action with spaces", 'quote"test',
              "back\\slash", "semi;colon", "tab\there"]]))
V(record_ok("long-action-name", [224], [jse({"action_name": "z" * 500})]))
V(record_ok("action-name-case", [224, 225],
            ['{"action_name":"Add_Node"}', '{"action_name":"add_node"}']))

# ------------------------------------------------- D: error parity
V(record_err("err-length-mismatch", [0, 224, 1], ['{}', '{}']))
V(record_err("err-empty-inputs", [], []))
V(record_err("err-no-menu-token", [0, 1], ['{}', '{}']))
V(record_err("err-tid-negative", [-1, 224], ['{}', '{"action_name":"x"}']))
V(record_err("err-tid-too-big", [65536, 224], ['{}', '{"action_name":"x"}']))
V(record_err("err-tid-float", [1.5, 224], ['{}', '{"action_name":"x"}']))
V(record_err("err-tid-string", ["224"], ['{"action_name":"x"}']))
V(record_err("err-tid-null", [None, 224], ['{}', '{"action_name":"x"}']))
V(record_err("err-field-not-json", [224], ["not json"]))
V(record_err("err-field-truncated", [224], ["{bad"]))
V(record_err("err-field-truncated-array", [224], ["[1,2"]))
V(record_err("err-menu-missing-name", [224], ['{"a":1}']))
V(record_err("err-menu-empty-name", [224], ['{"action_name":""}']))
V(record_err("err-menu-numeric-name", [224], ['{"action_name":7}']))
V(record_err("err-menu-null-name", [224], ['{"action_name":null}']))
V(record_err("err-menu-array-field", [224], ["[1,2]"]))
V(record_err("err-menu-string-field", [224], ['"hi"']))
V(record_err("err-menu-int-field", [224], ["42"]))
V(record_err("err-menu-bool-field", [224], ["true"]))
V(record_err("err-menu-null-field", [224], ["null"]))
V(record_err("err-menu-float-field", [224], ["2.5"]))

with open(os.path.join(OUT, "vectors.json"), "w", encoding="utf-8") as f:
    json.dump({"vectors": vectors}, f, ensure_ascii=False, indent=1)

# ---------------------------------------------------------------- fuzz
rng = random.Random(20261005)
ACTION_POOL = ["add_node", "add_collection_point", "connect", "set_field",
               "set_retention", "confirm_node", "flag_for_review", "run_check",
               "export", "skip_recipe_item", "undo_last", "abort_session",
               "ajouter_nœud", "添加节点", "nodo_🎉", "custom-action_1",
               "with space", 'q"uote', "back\\slash", "UPPER", "x" * 120]
STR_POOL = ["CRM", "Données clients", "日本語ラベル", "🎉", "a" * 80,
            "line1\nline2", "tab\there", 'quote"d', "back\\s", "éèê",
            "invoices", "Tax Act s. 230(4)", "", "0", "with-dash_and.dot"]
INT_POOL = [0, 1, -1, 40, 65535, 10 ** 30, -(10 ** 25), 7]
FLOAT_POOL = [0.0, -0.0, 0.1, 1e-4, 1e-5, 1e15, 1e16, 2.5, -3.25,
              123.456, 1e+51, 0.30000000000000004, 9999999999999998.0, 1.5e-7]
KEY_POOL = ["a", "z", "é", "中", "🎉", "node_id", "label", "type", "x", "y",
            "10", "2", "key with space", "k\\ey"]


def rand_scalar(depth):
    r = rng.random()
    if r < 0.25:
        return rng.choice(INT_POOL)
    if r < 0.40:
        return rng.choice(FLOAT_POOL)
    if r < 0.60:
        return rng.choice(STR_POOL)
    if r < 0.70:
        return rng.choice([True, False, None])
    if r < 0.80 or depth <= 0:
        return rng.choice(STR_POOL)
    if r < 0.90:
        return [rand_scalar(depth - 1) for _ in range(rng.randint(0, 4))]
    return {rng.choice(KEY_POOL): rand_scalar(depth - 1)
            for _ in range(rng.randint(0, 4))}


def rand_obj(depth=3):
    return {rng.choice(KEY_POOL): rand_scalar(depth)
            for _ in range(rng.randint(0, 6))}


fuzz = []
for i in range(200):
    ids, fields = [0], ["{}"]
    for _ in range(rng.randint(0, 5)):
        ids.append(rng.choice([32, 40, 60, 95]))
        fields.append(json.dumps(rand_obj(), ensure_ascii=rng.random() < 0.5))
    ids.append(2)
    fields.append("{}")
    for _ in range(rng.randint(0, 3)):
        ids.append(rng.choice([96, 120, 159]))
        fields.append(json.dumps(rand_obj()))
    ids.append(3)
    fields.append("{}")
    for _ in range(rng.randint(0, 3)):
        ids.append(rng.choice([160, 200, 223]))
        fields.append(json.dumps(rand_obj()))
    ids.append(4)
    fields.append("{}")
    for _ in range(rng.randint(1, 6)):
        name = rng.choice(ACTION_POOL)
        fobj = {"action_name": name}
        if rng.random() < 0.6:
            fobj["params_digest"] = "%08x" % rng.getrandbits(32)
        extra = rand_obj(1)
        extra.pop("action_name", None)
        fobj.update(extra)
        style = rng.random()
        if style < 0.4:
            text = json.dumps(fobj, ensure_ascii=True)
        elif style < 0.7:
            text = json.dumps(fobj, ensure_ascii=False)
        else:
            text = json.dumps(fobj, separators=(",", ":"))
        ids.append(rng.choice([224, 240, 260, 287]))
        fields.append(text)
    ids.append(1)
    fields.append("{}")
    fuzz.append(record_ok("fuzz-%03d" % i, ids, fields))

with open(os.path.join(OUT, "fuzz_vectors.json"), "w", encoding="utf-8") as f:
    json.dump({"vectors": fuzz}, f, ensure_ascii=False, indent=1)

print("wrote %d handcrafted + %d fuzz vectors" % (len(vectors), len(fuzz)))
