#!/usr/bin/env bash
#
# Layer 2: Semgrep-style pattern scan over first-party JS.
#
#   scanning/layer2/run.sh
#
# Runs the custom rules in scanning/layer2/rules/ against first-party JS
# under web/, mcp/, tools/, tests/, training/, teacher/ (excluding vendor,
# node_modules, and generated bundle copies), applies scan-allow suppressions
# and the documented allowlist via filter.js, and writes the contract JSON.
#
# Environment:
#   SCAN_OUT   report path, repo-root-relative.
#              Default: scanning/reports/layer2-latest.json
#
# Exit codes: 0 clean, 2 findings present, 1 tool error.
#
# Requires: semgrep (resolved via $SEMGREP_BIN, PATH, or ~/.venvs/semgrep/bin/semgrep), node on PATH.
# Telemetry is disabled (SEMGREP_SEND_METRICS=off); the rules are local, so
# no network access is needed at scan time.
#
# No em dashes.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "layer2: ERROR: node not found on PATH (needed by filter.js)." >&2
  exit 1
fi

# Resolve semgrep without requiring a venv on PATH (a venv's bin dir also
# shadows python3, which broke layer3's tree-sitter import in one nightly run).
# Precedence: explicit override, PATH, then the conventional venv location.
if [ -n "${SEMGREP_BIN:-}" ]; then
  SEMGREP="$SEMGREP_BIN"
elif command -v semgrep >/dev/null 2>&1; then
  SEMGREP="semgrep"
elif [ -x "$HOME/.venvs/semgrep/bin/semgrep" ]; then
  SEMGREP="$HOME/.venvs/semgrep/bin/semgrep"
else
  echo "layer2: ERROR: semgrep not found." >&2
  echo "layer2: install it with: pip install semgrep (or set SEMGREP_BIN)" >&2
  exit 1
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

export SEMGREP_SEND_METRICS=off

# Semgrep exits 0 (clean) or 1 (findings); 2+ means a tool failure.
set +e
"$SEMGREP" \
  --config scanning/layer2/rules \
  --json --output "$TMP" \
  --quiet --disable-version-check \
  --exclude='**/vendor/**' \
  --exclude='**/node_modules/**' \
  --exclude='**/bundle/**' \
  --exclude='engine-bundle.js' \
  web mcp tools tests training teacher >/dev/null 2>"$TMP.err"
SEMGREP_STATUS=$?
set -e

if [ "$SEMGREP_STATUS" -ge 2 ]; then
  echo "layer2: ERROR: semgrep failed (exit $SEMGREP_STATUS):" >&2
  cat "$TMP.err" >&2
  exit 1
fi

exec node scanning/layer2/filter.js "$ROOT" "$TMP"
