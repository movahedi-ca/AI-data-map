'use strict';
/*
 * Layer 1: fast linter for the AI-data-map code-scanning pipeline.
 * Pure Node.js stdlib, zero dependencies.
 *
 * Usage: node lint.js <repo-root> <output-json>
 *
 * Exit codes: 0 = ran clean, no findings; 2 = ran fine, findings present;
 *             1 = tool error.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(process.argv[2] || process.cwd());
const OUT = path.resolve(process.argv[3] || path.join(ROOT, 'scanning', 'reports', 'layer1-latest.json'));

const findings = [];
function add(rule, severity, file, line, message) {
  findings.push({ rule, severity, file, line, message });
}

const EXCLUDED_SEGMENTS = ['/vendor/', '/node_modules/', '/.git/'];
function excluded(p) {
  return EXCLUDED_SEGMENTS.some((seg) => p.includes(seg));
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!excluded(full + '/')) walk(full, out);
    } else if (ent.isFile()) {
      if (!excluded(full)) out.push(full);
    }
  }
}

function rel(full) {
  return path.relative(ROOT, full).split(path.sep).join('/');
}

function readLines(full) {
  return fs.readFileSync(full, 'utf8').split('\n');
}

const JS_DIRS = ['web', 'mcp', 'tools', 'tests', 'training', 'teacher'];
const SHIPPED_DIRS = ['web', 'mcp'];

/*
 * Split a JS source line into "code" spans, dropping string literals,
 * template literals (naive, single-line), and // comments. `state.inBlock`
 * tracks multi-line block comments across lines. Good enough for a fast
 * linter: it keeps regexes from firing on commented-out or quoted text.
 */
function codeSpans(line, state) {
  const spans = [];
  let buf = '';
  let i = 0;
  const flush = () => { if (buf) { spans.push(buf); buf = ''; } };
  while (i < line.length) {
    if (state.inBlock) {
      const end = line.indexOf('*/', i);
      if (end === -1) { i = line.length; break; }
      state.inBlock = false;
      i = end + 2;
      continue;
    }
    const c = line[i];
    const next = line[i + 1];
    if (c === '/' && next === '/') { i = line.length; break; }
    if (c === '/' && next === '*') { flush(); state.inBlock = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      flush();
      i += 1;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === c) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    buf += c;
    i += 1;
  }
  flush();
  return spans.join(' ');
}

/* Return the raw string-literal contents of a JS line (naive, single-line). */
function stringLiterals(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '"' || c === "'" || c === '`') {
      let lit = '';
      i += 1;
      while (i < line.length) {
        if (line[i] === '\\') { lit += line[i] + (line[i + 1] || ''); i += 2; continue; }
        if (line[i] === c) { i += 1; break; }
        lit += line[i];
        i += 1;
      }
      out.push(lit);
    } else {
      i += 1;
    }
  }
  return out;
}

/*
 * Rule 1: js-syntax (critical).
 * Performs the same V8 full-parse-without-execution that `node --check`
 * performs, but in-process: spawning one node process per file costs ~11s
 * for 78 files on a 2-core runner, blowing the 10s budget, while the
 * in-process parse takes under a second with identical error output.
 * (All first-party files here are classic scripts: no ESM import/export
 * syntax anywhere, so script-mode parsing matches `node --check`.)
 */
function checkSyntax(files) {
  for (const f of files) {
    let src;
    try {
      src = fs.readFileSync(f, 'utf8');
    } catch (e) {
      add('js-syntax', 'critical', rel(f), 1, 'could not read file: ' + e.message);
      continue;
    }
    try {
      new vm.Script(src, { filename: f });
    } catch (e) {
      const stack = (e.stack || e.message || '').toString();
      let line = 1;
      const m = stack.match(/^.*?:(\d+)\s*$/m);
      if (m) line = parseInt(m[1], 10);
      const detail = (stack.split('\n').find((l) => /SyntaxError|Error/.test(l)) || 'syntax error').trim();
      add('js-syntax', 'critical', rel(f), line, 'syntax check failed: ' + detail.slice(0, 200));
    }
  }
}

/* ---------- rule 2: em-dash (high) ---------- */
/* Built from the code point so this file itself contains no literal em dash. */
const EM_DASH = String.fromCodePoint(0x2014);
const ENTITY_RE = /&(mdash|#8212);/i;
/* Matches the six-character source sequence backslash-u-2014, not an em dash. */
const BACKSLASH_U_RE = /\\u2014/i;

function checkEmDash(files) {
  for (const f of files) {
    const isJs = f.endsWith('.js') || f.endsWith('.mjs');
    const lines = readLines(f);
    lines.forEach((line, idx) => {
      const n = idx + 1;
      /* Scan the full line: an em dash inside a string literal or comment
         is still a shipped em dash, and entities inside JS strings render
         via innerHTML at runtime. */
      if (line.includes(EM_DASH)) {
        add('em-dash', 'high', rel(f), n, 'literal em dash U+2014 found; use a comma, period, or colon instead');
      }
      const seen = new Set();
      for (const m of line.matchAll(new RegExp(ENTITY_RE.source, 'gi'))) {
        const ent = m[0].toLowerCase();
        if (!seen.has(ent)) {
          seen.add(ent);
          add('em-dash', 'high', rel(f), n, 'em dash as HTML entity ' + m[0] + ' found; use a comma, period, or colon instead');
        }
      }
      if (isJs) {
        for (const lit of stringLiterals(line)) {
          if (BACKSLASH_U_RE.test(lit)) {
            add('em-dash', 'high', rel(f), n, 'em dash written as a backslash-u unicode escape inside a JS string; it renders as a literal em dash at build time');
            break;
          }
        }
      }
    });
  }
}

/* ---------- rule 3: ai-word (medium) ---------- */
const AI_WORDS = [
  ['delve', /\bdelve\b/i],
  ['tapestry', /\btapestry\b/i],
  ['landscape', /\blandscape\b/i],
  ['unlock', /\bunlock\b/i],
  ['elevate', /\belevate\b/i],
  ['robust', /\brobust\b/i],
  ['furthermore', /\bfurthermore\b/i],
  ['moreover', /\bmoreover\b/i],
  ['in conclusion', /\bin conclusion\b/i],
  ["it's important to note", /\bit'?s important to note\b/i],
  ["not just X, it's Y", /not just .{1,60}?\,?\s+it'?s\s+[a-z]+/i],
];

function checkAiWords(files) {
  for (const f of files) {
    const lines = readLines(f);
    let inFence = false;
    lines.forEach((line, idx) => {
      if (/^\s*```/.test(line)) { inFence = !inFence; return; }
      if (inFence) return;
      const n = idx + 1;
      for (const [word, re] of AI_WORDS) {
        if (re.test(line)) {
          add('ai-word', 'medium', rel(f), n, 'AI-giveaway phrasing "' + word + '" in user-facing copy; rewrite in plain language');
        }
      }
    });
  }
}

/* ---------- rule 4: debug-log (medium) ---------- */
const CONSOLE_RE = /(?<![\w$.])console\.(log|debug)\s*\(/;
const DEBUGGER_RE = /(?<![\w$])debugger(?![\w$])/;

function checkDebugLog(files) {
  for (const f of files) {
    const lines = readLines(f);
    const state = { inBlock: false };
    lines.forEach((line, idx) => {
      const code = codeSpans(line, state);
      const n = idx + 1;
      const cm = code.match(CONSOLE_RE);
      if (cm) {
        add('debug-log', 'medium', rel(f), n, 'console.' + cm[1] + '() left in shipped code; remove or gate behind a debug flag');
      } else if (DEBUGGER_RE.test(code)) {
        add('debug-log', 'medium', rel(f), n, 'debugger statement left in shipped code; remove it');
      }
    });
  }
}

/* ---------- rule 5: eval-usage (high) ---------- */
const EVAL_RE = /(?<![\w$.])eval\s*\(/;
const NEW_FUNCTION_RE = /\bnew\s+Function\s*\(/;

function checkEval(files) {
  for (const f of files) {
    const lines = readLines(f);
    const state = { inBlock: false };
    lines.forEach((line, idx) => {
      const code = codeSpans(line, state);
      const n = idx + 1;
      if (EVAL_RE.test(code)) {
        add('eval-usage', 'high', rel(f), n, 'eval() call found; replace with a safe parser or explicit dispatch');
      }
      if (NEW_FUNCTION_RE.test(code)) {
        add('eval-usage', 'high', rel(f), n, 'new Function() found; replace with a safe parser or explicit dispatch');
      }
    });
  }
}

async function main() {
  /* collect file sets */
  const jsFiles = [];
  for (const d of JS_DIRS) {
    const dir = path.join(ROOT, d);
    if (fs.existsSync(dir)) walk(dir, jsFiles);
  }
  const firstPartyJs = jsFiles.filter((f) => f.endsWith('.js'));

  const shippedFiles = [];
  for (const d of SHIPPED_DIRS) {
    const dir = path.join(ROOT, d);
    if (fs.existsSync(dir)) walk(dir, shippedFiles);
  }
  const shippedTextExts = new Set(['.js', '.mjs', '.html', '.htm', '.css', '.json', '.md', '.yaml', '.yml', '.txt', '.xml', '.svg']);
  const shippedScannable = shippedFiles.filter(
    (f) => !f.endsWith('.test.js') && shippedTextExts.has(path.extname(f).toLowerCase())
  );

  const copyFiles = [];
  walk(ROOT, copyFiles);
  const copyScannable = copyFiles.filter((f) => {
    const e = path.extname(f).toLowerCase();
    return e === '.md' || e === '.html' || e === '.htm';
  });

  const debugFiles = [];
  /* debug-log policy: shipped tool-page code only (web/, mcp/). Excludes
     tools/ (CLI dev tools where console.log is the output channel) and
     *.test.js (tests may log). Triage 2026-10-05: 15 tools/ hits were all
     legitimate CLI output, so the rule was narrowed to stop crying wolf. */
  for (const d of ['web', 'mcp']) {
    const dir = path.join(ROOT, d);
    if (fs.existsSync(dir)) walk(dir, debugFiles);
  }
  const debugJs = debugFiles.filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));

  /* run checks */
  checkSyntax(firstPartyJs);
  checkEmDash(shippedScannable);
  checkAiWords(copyScannable);
  checkDebugLog(debugJs);
  checkEval(firstPartyJs);

  /* write report */
  findings.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line
  );

  const report = {
    layer: 1,
    generated_utc: new Date().toISOString(),
    findings,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');

  process.stderr.write(
    'layer1: scanned ' + firstPartyJs.length + ' JS files, ' +
    findings.length + ' findings -> ' + path.relative(ROOT, OUT) + '\n'
  );
  return findings.length > 0 ? 2 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write('layer1: tool error: ' + (e && e.message ? e.message : e) + '\n');
    process.exit(1);
  }
);
