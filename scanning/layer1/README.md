# Layer 1: fast linter

Layer 1 is the fast gate of the code-scanning pipeline. It runs syntax and
style checks over first-party JavaScript and user-facing copy. Pure Node.js
stdlib, zero dependencies, completes in under 10 seconds on the repo.

## Run standalone

From the repo root:

```bash
./scanning/layer1/run.sh
```

The report lands at `scanning/reports/layer1-latest.json` (default). Override
with the `SCAN_OUT` env var (relative paths resolve against the repo root):

```bash
SCAN_OUT=/tmp/layer1.json ./scanning/layer1/run.sh
```

Exit codes: `0` ran clean with no findings, `2` ran fine with findings
present, `1` tool error (node missing, report not writable, linter crashed).

Report shape:

```json
{
  "layer": 1,
  "generated_utc": "<ISO-8601>",
  "findings": [
    {
      "rule": "<rule-id>",
      "severity": "critical|high|medium|low|info",
      "file": "<repo-relative path>",
      "line": 12,
      "message": "<plain text>"
    }
  ]
}
```

## Rules

| Rule id     | Severity | Scope | What it checks |
|-------------|----------|-------|----------------|
| `js-syntax` | critical | every first-party `.js` file under `web/`, `mcp/`, `tools/`, `tests/`, `training/`, `teacher/` (paths containing `/vendor/` or `/node_modules/` excluded) | full V8 parse without execution, the same check `node --check` performs, run in-process so 78 files stay inside the 10s budget (spawning one node per file costs ~11s on a 2-core runner); reports the first parse error with its line number. `.mjs` files are out of scope: they use ESM `import`/`export` syntax, which false-positives under `vm.Script` script-mode parsing, so an `.mjs` syntax error only surfaces if a test exercises it |
| `em-dash`   | high     | shipped text files under `web/` and `mcp/`, excluding `*.test.js` | bans the em dash in all three smuggled forms: literal U+2014, the named and decimal HTML entities for U+2014, and backslash-u unicode escapes for U+2014 inside JS strings. The finding message names which form matched. |
| `ai-word`   | medium   | all first-party `*.md` and `*.html` files (fenced code blocks skipped) | flags banned AI-giveaway words and phrases in user-facing copy, case-insensitive (the full list lives in the `AI_WORDS` table in `lint.js`), plus the concessive "not merely X, rather Y" sentence shape |
| `debug-log` | medium   | `.js` files under `web/`, `mcp/`, excluding `*.test.js` | flags `console.log(`, `console.debug(`, and `debugger` statements in shipped code. `tools/` CLIs are out of scope (console.log is their output channel); `tests/` and `scanning/` are out of scope |
| `eval-usage`| high     | every first-party `.js` file (same set as `js-syntax`) | flags `eval(` and `new Function(` |

## Notes

- Matches inside JS string literals and `//` or `/* */` comments are ignored
  for `debug-log` and `eval-usage`, so commented-out code does not trip the
  linter. A finding means the pattern appears in real code.
- `js-syntax` reports only the first parse error per file; fix and re-run.
- This layer never auto-fixes. Fix findings by hand, then re-run until the
  exit code is 0.
