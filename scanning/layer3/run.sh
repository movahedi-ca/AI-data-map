#!/bin/bash
# scanning/layer3/run.sh - Layer 3: tree-sitter code graph scan.
# Scans first-party JS for dead functions, wrapper functions, unused exports,
# TODO markers, and duplicate function bodies.
#
# Usage: bash scanning/layer3/run.sh   (run from the repo root)
# Env:   SCAN_OUT - report path, repo-root-relative or absolute
#                  (default: scanning/reports/layer3-latest.json)
# Exit codes: 0 clean, 2 findings present, 1 tool error.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

OUT="${SCAN_OUT:-scanning/reports/layer3-latest.json}"
case "$OUT" in
  /*) ;;
  *) OUT="$ROOT/$OUT" ;;
esac

export SCAN_ROOT="$ROOT"
export SCAN_OUT_PATH="$OUT"

exec python3 "$SCRIPT_DIR/layer3.py"
