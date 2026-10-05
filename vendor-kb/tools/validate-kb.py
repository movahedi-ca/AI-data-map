#!/usr/bin/env python3
"""Validate vendor-kb entries against schema.json plus the retention-rule
custom checks that JSON Schema cannot express.

Usage: validate-kb.py <entries.json>   (a JSON array of entry objects)
Exit 0 when all entries pass; prints every violation otherwise.
"""
import json, re, sys

SCHEMA_PATH = sys.argv[1] if len(sys.argv) > 2 and sys.argv[1] == "--schema" else None

def load_schema(path):
    import jsonschema
    with open(path, encoding="utf-8") as fh:
        return json.load(fh), jsonschema.Draft7Validator

LAW25_NUM = re.compile(r"(?i)(law\s*25|loi\s*25).{0,80}?\d+\s*(?:-|to|à)?\s*\d*\s*(years?|yrs?|months?|ans|mois)")
LAW25_NUM_REV = re.compile(r"(?i)\d+\s*(?:-|to|à)?\s*\d*\s*(years?|yrs?|months?|ans|mois).{0,60}?(law\s*25|loi\s*25)")
MONEY = re.compile(r"[$€£]\s?\d|\d+\s?(USD|CAD|EUR|dollars?)")

def law25_number_violation(text):
    if not (LAW25_NUM.search(text) or LAW25_NUM_REV.search(text)):
        return False
    deny = re.compile(r"(?i)(law\s*25|loi\s*25).{0,80}?(sets no|fixes none|does not|ne (pr[eé]voit|fixe) (aucun|pas))")
    return not deny.search(text)

def custom_checks(entry, errors):
    text_fields = {
        "description": entry["description"],
        "law25_relevance": entry["law25_relevance"],
        "retention_features.notes": entry["retention_features"]["notes"],
    }
    for i, mf in enumerate(entry["mapping_features"]):
        text_fields[f"mapping_features[{i}]"] = mf
    for field, text in text_fields.items():
        if law25_number_violation(text):
            errors.append(f"{field} attributes a numerical period to Law 25")
    rf = entry["retention_features"]
    if rf["verify"] and rf["claims"]:
        errors.append("retention_features.verify is true but claims are non-empty")
    if not rf["verify"] and not rf["claims"] and "unverified" not in rf["notes"].lower():
        errors.append("no retention claims and verify=false: notes must explain or use verify=true")
    for c in rf["claims"]:
        if re.search(r"(?i)law\s*25|loi\s*25", c["statute"]):
            errors.append(f"retention claim cites Law 25 as statute: {c['statute']}")
    pm = entry["pricing_model"]
    if MONEY.search(pm):
        notes = " ".join(s.get("note", "") for s in entry["sources"])
        if "pricing" not in notes.lower() and "pricing" not in pm.lower():
            errors.append("pricing_model states a figure but no source note mentions pricing")
    urls = [s["url"] for s in entry["sources"]]
    if len(set(urls)) != len(urls):
        errors.append("duplicate source urls")

def main():
    argv = sys.argv[1:]
    schema_arg = None
    rest = []
    i = 0
    while i < len(argv):
        if argv[i] == "--schema":
            schema_arg = argv[i + 1]
            i += 2
        else:
            rest.append(argv[i])
            i += 1
    if not rest or not schema_arg:
        print("usage: validate-kb.py --schema schema.json entries.json", file=sys.stderr)
        sys.exit(2)
    schema, Validator = load_schema(schema_arg)
    with open(rest[0], encoding="utf-8") as fh:
        entries = json.load(fh)
    if not isinstance(entries, list):
        print("entries file must be a JSON array", file=sys.stderr); sys.exit(2)
    v = Validator(schema)
    seen_ids, bad = set(), 0
    for e in entries:
        errs = [err.message for err in v.iter_errors(e)]
        eid = e.get("id", "<no id>")
        if eid in seen_ids:
            errs.append(f"duplicate id {eid}")
        seen_ids.add(eid)
        try:
            custom_checks(e, errs)
        except KeyError as ke:
            errs.append(f"missing field for custom check: {ke}")
        if errs:
            bad += 1
            print(f"FAIL {eid}:")
            for x in errs:
                print(f"  - {x}")
    print(f"{len(entries) - bad}/{len(entries)} entries valid")
    sys.exit(1 if bad else 0)

if __name__ == "__main__":
    main()
