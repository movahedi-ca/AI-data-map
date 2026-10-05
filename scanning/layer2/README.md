# Layer 2: pattern scan

Semgrep-style pattern scan over the codebase's real risk surface: network
exfiltration sinks, dangerous HTML sinks, SpreadsheetML formula injection,
prototype pollution, insecure randomness in deterministic paths, and hardcoded
secrets.

## Engine choice: real Semgrep

`pip install semgrep` works in this environment (verified with semgrep 1.179.0),
so Layer 2 uses real Semgrep, not a regex reimplementation. AST matching is
what makes two of these rules honest:

- `dangerous-html-sink` binds the sink argument as a metavariable and only
  flags it when it is not a pure string literal. A regex would either miss the
  template-literal cases or drown in false positives.
- `proto-pollution` matches `Object.assign(dst, JSON.parse(...))`
  syntactically, which needs the call structure, not the text.

Rules live in `rules/*.yml`, one file per rule, written in Semgrep's rule
format. Each rule carries `metadata.contract_severity`, which maps Semgrep's
INFO/WARNING/ERROR onto the report's info/low/medium/high/critical scale
(the mapping is the point: Semgrep severities do not match our contract).

`run.sh` shells out to `semgrep --config scanning/layer2/rules` and pipes the
JSON through `filter.js` (Node standard library only), which:

1. Honors inline suppressions: `// scan-allow: <rule-id> <short reason>` on
   the flagged line or the line above it (and `<!-- scan-allow: ... -->` in
   HTML sources). The rule id must match exactly. Use these in test and
   dev-tooling files only.
2. Applies the architectural allowlist in `filter.js` (the `ALLOWLIST`
   table): findings that are deliberate design decisions in shipped files
   (for example the same-origin vendored model `fetch`, or the structural
   `ss:Type="String"` formula guard in the SpreadsheetML exporters). The
   allowlist lives in the scanner, not in shipped source, so adding an
   exception does not change shipped bytes or invalidate the pinned
   bundle/CSP hashes. Each entry names its `FINDINGS.md` row and carries a
   `lineRe` guard pattern: if the flagged line stops matching, the finding
   reappears. An `exfiltration-sink` finding inside `mcp/http-bridge.js`
   (the optional local bridge, which serves HTTP by design) is reported as
   `info`, not `high`.
3. Writes the contract JSON and sets the exit code.

If you ever need to swap the engine (for example, an environment where
Semgrep cannot be installed), keep `run.sh`'s contract and reimplement only
the matching step; `filter.js` and the report format stay the same.

## Scope

First-party JS (`.js` and `.mjs`) under `web/`, `mcp/`, `tools/`, `tests/`,
`training/`, `teacher/`. Excluded, deliberately:

- `**/vendor/**`, `**/node_modules/**`: third-party code. The vendored
  onnxruntime bundle contains inert strings (comment URLs, minified dead
  branches) that naive scans flag; vendor integrity is covered by
  `tests/security/dependency-hygiene.test.js` (sha256 pins), and runtime
  behavior by the instrumented request counter in
  `tests/security/no-exfiltration.test.js`.
- `**/bundle/**` and `engine-bundle.js`: generated deploy copies of
  first-party sources. Scanning them would double-count every finding; the
  repo's own security tests deduplicate by content hash for the same reason.
- `web/executor/js/net-guard.js` (in the exfiltration rule only): the request
  instrumenter itself. It wraps the primitives to count cross-origin requests
  for the trust UI and never originates one; asserted by
  `tests/security/no-exfiltration.test.js`.

## Rules

| Rule | Severity | What it flags |
|---|---|---|
| `exfiltration-sink` | high (info in `mcp/http-bridge.js`) | `fetch(`, `new XMLHttpRequest(`, `new WebSocket(`, `navigator.sendBeacon(`, `new EventSource(` |
| `dangerous-html-sink` | high | `.innerHTML =`, `insertAdjacentHTML(`, `document.write(` with a non-constant argument (pure string literals and `${}`-free template literals are not flagged) |
| `formula-injection` | medium | `<Data>` cell construction joined to a value by `+` concatenation or `${}` interpolation, without a formula guard (`sanitizeFormula` and friends). Textual heuristic. Note: `escapeXml` stops XML injection but does not stop a leading `= + - @` from evaluating as a formula in Excel. |
| `proto-pollution` | high | `Object.assign` / `merge` variants with a `JSON.parse(...)` source; `__proto__` as an assignment target or object-literal key. Guard comparisons (`key === "__proto__"`) and `Object.defineProperty` do not match. |
| `insecure-random` | medium | `Math.random(` limited to the deterministic paths: `web/executor/js`, `web/chatbot/js`, `mcp` |
| `hardcoded-secret` | critical | Known key prefixes (`sk-`, `AKIA`, `xox-`, `ghp_`, `gho_`, `glpat-`); key-like names (`apiKey`, `secret`, `password`, ...) assigned a string of 8+ chars; long high-entropy strings in assignments/comparisons. Exactly-64-hex strings are excluded: this codebase pins sha256 integrity hashes deliberately (`MODEL_SHA256`, `H0`), covered by the dependency-hygiene tests. |

## Running it

```sh
scanning/layer2/run.sh
# or: SCAN_OUT=scanning/reports/layer2-custom.json scanning/layer2/run.sh
```

Requires `node` on PATH and `semgrep` resolvable via `$SEMGREP_BIN`, PATH, or
`~/.venvs/semgrep/bin/semgrep` (in that order). Telemetry is off
(`SEMGREP_SEND_METRICS=off`); the rules are local, so no network is used at
scan time.

Exit codes: `0` clean, `2` findings present, `1` tool error (semgrep missing,
semgrep failure, or a filter crash).

The report goes to `$SCAN_OUT`, default
`scanning/reports/layer2-latest.json`:

```json
{
  "layer": 2,
  "generated_utc": "<ISO>",
  "engine": "semgrep",
  "findings": [
    {"rule": "exfiltration-sink", "severity": "high",
     "file": "web/chatbot/js/chatbot.js", "line": 42, "message": "..."}
  ]
}
```

## Suppressions

Prefer fixing the code. When a finding is a reviewed, documented exception in a
test or dev-tooling file, suppress it inline with a reason:

```js
// scan-allow: exfiltration-sink test subject: asserts the harness flags non-localhost fetches
```

For shipped files, never add an inline suppression: it changes shipped bytes
and invalidates the pinned bundle and CSP hashes. Add the exception to the
`ALLOWLIST` in `filter.js` instead, with its `FINDINGS.md` row id and a
`lineRe` guard.

Current architectural exceptions (all in the `ALLOWLIST`, none in source):
F-001, the model `fetch` in `web/executor/js/executor.js` (same-origin,
sha256-verified in browser before use); F-002, the localhost fixture `fetch`
in the Playwright QA harness `web/canvas/tools/qa-canvas.mjs` (the harness
itself asserts zero non-localhost requests); F-003, the `formula-injection`
rule on the SpreadsheetML `cell()` writers (compensating control: every cell
is emitted as `ss:Type="String"` with no `ss:Formula` attribute, asserted by
`tests/security/formula-injection.test.js`). No test-file suppressions were
needed: the attack strings in `tests/security/` live in comments, regex
literals, and harness mocks, which the AST patterns do not match.

## Known limitations

- `formula-injection` is textual, not dataflow: it cannot tell whether the
  interpolated value already passed through a guard two calls up the stack.
- `proto-pollution` matches `JSON.parse(...)` sources syntactically; a parsed
  object stored in a variable and merged later is missed. Deep dataflow is
  the nightly scan's job, not this layer's.
- `hardcoded-secret` cannot distinguish a real 64-hex-character secret from a
  sha256 pin; pins win by design decision (see above).
- Inline `<script>` in HTML demo pages is out of scope; the demo pages were
  checked by hand and contain no sinks.

No em dashes.
