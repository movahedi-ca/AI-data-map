#!/bin/bash
# Layer 1 runner: fast linter for the AI-data-map code-scanning pipeline.
# Reads SCAN_OUT (repo-relative, default: scanning/reports/layer1-latest.json).
# Exit codes: 0 = ran clean, no findings; 2 = ran fine, findings present;
#             1 = tool error.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

OUT="${SCAN_OUT:-scanning/reports/layer1-latest.json}"
case "$OUT" in
  /*) ;;
  *) OUT="$ROOT/$OUT" ;;
esac

mkdir -p "$(dirname "$OUT")" || { echo "layer1: cannot create report dir" >&2; exit 1; }

command -v node >/dev/null 2>&1 || { echo "layer1: node not found on PATH" >&2; exit 1; }

node "$ROOT/scanning/layer1/lint.js" "$ROOT" "$OUT"
