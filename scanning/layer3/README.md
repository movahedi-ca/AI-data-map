# Layer 3: tree-sitter code graph scan

Slop / dead-code detection over first-party JavaScript, built on
[tree-sitter](https://tree-sitter.github.io/tree-sitter/) with the
`tree_sitter_javascript` grammar (both installed from PyPI).

## Parser choice

`pip install tree-sitter tree_sitter_javascript` succeeded in this environment,
so the real tree-sitter parser is used (`"parser": "tree-sitter"` in the
report). The `fallback` value is reserved for an environment where tree-sitter
cannot be installed; there is no regex approximation shipped yet, because the
real parser works. If a future environment cannot install it, the script exits
with a clear tool error (exit 1) rather than silently degrading.

## Queries

| rule | severity | what it flags |
|---|---|---|
| `dead-function` | medium | `function` declarations and `const` arrow/function expressions that are never referenced anywhere in first-party code and are not exported |
| `wrapper-function` | low | function whose body is a single call (direct or `return`ed) delegating to another function with no added logic |
| `unused-export` | low | names exported via `export ...`, `module.exports = {...}`, or `exports.x = ...` that are never imported or required by first-party code |
| `todo-inventory` | info | `TODO`, `FIXME`, `XXX`, `HACK` comments with file and line |
| `duplicate-block` | low | identical normalized function bodies (comments/whitespace stripped, brace-only lines dropped, minimum 6 non-trivial lines) appearing in more than one place; reported once per repeated body |

## Scope

First-party `.js`/`.mjs` under `web/`, `mcp/`, `tools/`, `tests/`, `training/`,
`teacher/`, excluding any `vendor/` or `node_modules/` directories.

## Interface

- Entry point: `scanning/layer3/run.sh` (executable). Run from the repo root.
- `SCAN_OUT` env var selects the report path (repo-root-relative or
  absolute); default `scanning/reports/layer3-latest.json`.
- Report JSON: `{"layer": 3, "generated_utc": "<ISO>", "parser":
  "tree-sitter|fallback", "stats": {"files": n, "functions": n}, "findings":
  [{"rule", "severity", "file", "line", "message"}]}`.
- Exit codes: `0` clean, `2` findings present, `1` tool error.
- A short human summary (counts by rule) is printed to stdout.

## Heuristic limits (known)

Name resolution is global, not scope-aware: a function name referenced
anywhere in first-party code counts as used, which can miss shadowing and can
over-count member-expression properties (`server.foo()` marks `foo` used
everywhere). Nested/anonymous functions are only tracked when they have a
name. Import resolution handles relative paths only. These findings are
signals for the weekly fix cycle, not verdicts.
