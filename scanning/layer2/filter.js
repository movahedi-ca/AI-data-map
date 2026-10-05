#!/usr/bin/env node
"use strict";
/*
 * filter.js - Layer 2 post-processor (Node standard library only).
 *
 * Reads semgrep --json output, then:
 *   1. Drops findings suppressed by an inline comment on the flagged line or
 *      the line above it:
 *        // scan-allow: <rule-id> <short reason>
 *        <!-- scan-allow: <rule-id> <short reason> -->   (HTML sources)
 *      The rule id in the comment must match the finding's rule id exactly.
 *   2. Applies the documented allowlist: exfiltration-sink findings inside
 *      mcp/http-bridge.js (the optional local bridge) are reported as info,
 *      not high; plus the ALLOWLIST of architectural decisions (e.g. the
 *      same-origin vendored model fetch, the structural ss:Type=String
 *      formula guard), each tied to a FINDINGS.md row and self-validated by
 *      a line pattern so the finding reappears if the code changes shape.
 *   3. Emits the Layer 2 contract JSON to SCAN_OUT.
 *
 * Usage: node filter.js <repo-root> <semgrep-json-path>
 * Exit code: 0 when no findings remain, 2 when findings remain, 1 on error.
 *
 * No em dashes.
 */
const fs = require("fs");
const path = require("path");

const ROOT = process.argv[2];
const SEMGREP_JSON = process.argv[3];
const OUT_REL = process.env.SCAN_OUT || "scanning/reports/layer2-latest.json";

const SEMGREP_FALLBACK = { INFO: "info", WARNING: "high", ERROR: "critical" };
const SCAN_ALLOW_RE = /(?:\/\/|<!--)\s*scan-allow:\s*([A-Za-z0-9_-]+)/;

/* Architectural allowlist: findings that are deliberate design decisions.
   Unlike inline // scan-allow comments, these live in the scanner so shipped
   file bytes (and their pinned bundle/CSP hashes) do not churn when a
   suppression is added. Each entry names the FINDINGS.md row that documents
   it, and the lineRe acts as a self-validating guard: if the flagged line
   stops matching, the finding reappears. */
const ALLOWLIST = [
  { rule: "exfiltration-sink", file: "web/executor/js/executor.js",
    lineRe: /same-origin/,
    finding: "F-001",
    reason: "same-origin vendored model load, sha256-verified in browser before use" },
  { rule: "exfiltration-sink", file: "web/canvas/tools/qa-canvas.mjs",
    lineRe: /fetch\(url\)/,
    finding: "F-002",
    reason: "QA harness only: fetches a fixture from the local dev server under test; the harness itself asserts zero non-localhost requests" },
  { rule: "formula-injection", file: "web/executor/js/exporter.js",
    lineRe: /ss:Type=\\?"String/,
    finding: "F-003",
    reason: "compensating control: every cell is emitted as ss:Type=String with no ss:Formula attribute, so spreadsheet apps treat content as text; asserted by tests/security/formula-injection.test.js (41 assertions)" },
  { rule: "formula-injection", file: "web/import/engine/spreadsheetml-parser.js",
    lineRe: /ss:Type=\\?"String/,
    finding: "F-003",
    reason: "same compensating control as exporter.js" },
];

function isAllowlisted(rule, file, lineText) {
  return ALLOWLIST.some(function (a) {
    return a.rule === rule && a.file === file && a.lineRe.test(lineText || "");
  });
}

function main() {
  if (!ROOT || !SEMGREP_JSON) {
    console.error("filter.js: usage: node filter.js <repo-root> <semgrep-json-path>");
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(SEMGREP_JSON, "utf8"));
  const lineCache = new Map();
  function linesOf(abs) {
    if (!lineCache.has(abs)) {
      lineCache.set(abs, fs.readFileSync(abs, "utf8").split("\n"));
    }
    return lineCache.get(abs);
  }
  function isSuppressed(rule, file, line) {
    const abs = path.join(ROOT, file);
    let lines;
    try {
      lines = linesOf(abs);
    } catch (e) {
      return false; /* unreadable source: keep the finding */
    }
    const candidates = [];
    if (line >= 1 && lines[line - 1] !== undefined) candidates.push(lines[line - 1]);
    if (line >= 2 && lines[line - 2] !== undefined) candidates.push(lines[line - 2]);
    for (const text of candidates) {
      const m = text.match(SCAN_ALLOW_RE);
      if (m && m[1] === rule) return true;
    }
    return false;
  }

  const findings = [];
  for (const r of raw.results || []) {
    /* Local rule ids arrive as a dotted path (scanning.layer2.rules.<id>);
       keep only the final component. */
    const rule = String(r.check_id || "").split(/[/.]/).pop();
    const file = r.path;
    const line = r.start && r.start.line;
    if (!rule || !file || !line) continue;
    if (isSuppressed(rule, file, line)) continue;
    /* Architectural allowlist (documented design decisions; see ALLOWLIST). */
    var abs2 = path.join(ROOT, file);
    var lineText = "";
    try { lineText = linesOf(abs2)[line - 1] || ""; } catch (e) { /* keep finding */ }
    if (isAllowlisted(rule, file, lineText)) continue;
    let severity =
      (r.extra && r.extra.metadata && r.extra.metadata.contract_severity) ||
      SEMGREP_FALLBACK[(r.extra && r.extra.severity) || ""] ||
      "medium";
    /* Documented allowlist: the optional MCP HTTP bridge serves local HTTP by
       design; a sink pattern there is informational, not high. */
    if (rule === "exfiltration-sink" && /(^|\/)mcp\/http-bridge\.js$/.test(file)) {
      severity = "info";
    }
    findings.push({
      rule: rule,
      severity: severity,
      file: file,
      line: line,
      message: (r.extra && r.extra.message) || "",
    });
  }
  findings.sort(function (a, b) {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });

  const report = {
    layer: 2,
    generated_utc: new Date().toISOString(),
    engine: "semgrep",
    findings: findings,
  };
  const outAbs = path.isAbsolute(OUT_REL) ? OUT_REL : path.join(ROOT, OUT_REL);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, JSON.stringify(report, null, 2) + "\n");

  return findings.length === 0 ? 0 : 2;
}

try {
  process.exit(main());
} catch (e) {
  console.error("filter.js: ERROR: " + (e && e.stack || e));
  process.exit(1);
}
