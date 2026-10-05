# scanning/ - the layered code-scanning pipeline

Four layers, one contract. Every layer is a `run.sh` that writes findings JSON
and exits 0 (clean), 2 (findings), or 1 (tool error). `nightly.sh` runs them
all plus the test suite and files results for the weekly fix cycle.

## Layers

1. **layer1/** - fast linter. `node --check` on every first-party JS file, plus
   the standing hygiene rules: no em dashes (three forms), no AI-giveaway words
   in user-facing copy, no console.log/debugger leftovers, no eval/new Function.
   Pure Node stdlib, under 10 seconds. Runs on every push.
2. **layer2/** - Semgrep-style pattern scan. Rules target this codebase's real
   risk surface: exfiltration sinks, dangerous HTML sinks, formula injection,
   prototype pollution, insecure randomness, hardcoded secrets. Supports
   `// scan-allow: <rule-id> <reason>` suppressions.
3. **layer3/** - tree-sitter code graph. Dead functions, wrapper functions,
   unused exports, TODO/FIXME inventory, duplicate blocks. Machine-readable
   JSON plus a human summary.
4. **nightly.sh** - the deep scan. Runs layers 1-3 and the full test suite,
   writes a timestamped report to `scanning/reports/<TS>/`, and points
   `scanning/reports/latest` at it. New findings get filed in `FINDINGS.md`.

## Scope

First-party JS under `web/`, `mcp/`, `tools/`, `tests/`, `training/`,
`teacher/`, excluding `/vendor/` and `/node_modules/`. Scanning is dev-time
only: nothing here ships to the tool pages, and the zero-third-party-scripts
rule for shipped pages is untouched.

## CI

- `.github/workflows/test.yml` - push/PR: tests plus the layer 1 fast linter.
- `.github/workflows/nightly-scan.yml` - nightly cron: the full deep scan,
  report uploaded as an artifact.

## The fix cycle

`FINDINGS.md` is the queue. The weekly fix cycle takes open rows, highest
severity first, fixes or dispositions them, and re-runs the nightly scan to
confirm. See FINDINGS.md for the full contract.
