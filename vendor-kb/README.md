# Vendor knowledge base

Roughly 100 verified records on tools and vendors relevant to data mapping and
privacy compliance, with emphasis on Quebec Law 25. Each record is a structured
JSON object validated against `schema.json`.

## Entry bar

- Every factual claim traces to at least one URL in the entry's `sources`.
- No invented vendors, features, or prices. A fact that cannot be verified is
  the literal string `"unverified"`, never a guess.
- Retention claims obey `../specs/RETENTION-RULE.md`: ranges only, statute name
  plus section plus as-of date. Law 25 is never cited as the source of a
  numerical retention period. Entries that cannot cite a statute carry
  `"verify": true` and no range.

## Layout

- `schema.json` - the entry schema (required fields, formats).
- `entries/` - one JSON array file per category chunk.
- `tools/validate-kb.py` - validator: schema plus the retention-rule custom
  checks that JSON Schema cannot express.
- `tests/records.json` - must-pass and must-fail fixture records.
- `SOURCES.md` - index of every source URL used across entries.

## Validate

From the repo root:

```
python3 vendor-kb/tools/validate-kb.py --schema vendor-kb/schema.json vendor-kb/entries/<chunk>.json
```

Exit 0 means every entry in the file passes. The must-fail fixtures in
`tests/records.json` must keep failing; if any of them passes, the validator
has regressed.
