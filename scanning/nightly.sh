#!/bin/bash
# scanning/nightly.sh - Layer 4: the nightly deep scan.
# Runs layers 1-3 plus the full test suite, writes a timestamped report,
# and files any new findings into scanning/FINDINGS.md for the weekly fix cycle.
# Usage: bash scanning/nightly.sh  (run from the repo root)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TS="$(date -u +%Y%m%d-%H%M%S)"
REPORT_DIR="$ROOT/scanning/reports/$TS"
mkdir -p "$REPORT_DIR"
SUMMARY="$REPORT_DIR/summary.json"
echo "nightly deep scan $TS"

run_layer() {
  local n="$1"
  local out="$REPORT_DIR/layer$n.json"
  local runner="$ROOT/scanning/layer$n/run.sh"
  if [ -f "$runner" ]; then
    # Invoked via bash explicitly: never depend on the executable bit, which
    # the GitHub Contents API does not preserve on commit.
    SCAN_OUT="$out" bash "$runner" > "$REPORT_DIR/layer$n.log" 2>&1
    echo "layer$n exit=$? findings=$(node -e "console.log((require('$out').findings||[]).length)" 2>/dev/null || echo '?')"
  else
    echo "layer$n MISSING: $runner not found"
  fi
}

run_layer 1
run_layer 2
run_layer 3

# Full test suite (zero npm deps: node tests/run-all.js)
TEST_LOG="$REPORT_DIR/tests.log"
TEST_EXIT=0
if node "$ROOT/tests/run-all.js" > "$TEST_LOG" 2>&1; then
  echo "tests PASS"
else
  TEST_EXIT=$?
  echo "tests FAIL (exit $TEST_EXIT), see $TEST_LOG"
fi

# Aggregate summary
node -e "
const fs = require('fs');
const dir = process.argv[1], ts = process.argv[2], testExit = Number(process.argv[3]);
const summary = { generated_utc: new Date().toISOString(), run: ts, layers: {}, tests: { exit: testExit } };
for (const n of [1, 2, 3]) {
  const p = dir + '/layer' + n + '.json';
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const by = {};
    for (const f of d.findings || []) by[f.severity] = (by[f.severity] || 0) + 1;
    summary.layers[n] = { findings: (d.findings || []).length, by_severity: by };
  } catch (e) { summary.layers[n] = { error: 'no report' }; }
}
fs.writeFileSync(dir + '/summary.json', JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
" "$REPORT_DIR" "$TS" "$TEST_EXIT"

# Keep a stable pointer to the latest run
ln -sfn "$TS" "$ROOT/scanning/reports/latest"
echo "report written to $REPORT_DIR"
echo "Next: review new findings and file them in scanning/FINDINGS.md for the weekly fix cycle."
