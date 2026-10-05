"use strict";
/* csp-coverage.test.js - every shipped S1 script has a pinned CSP hash.
 *
 * Run: node tests/security/csp-coverage.test.js   (from the repo root)
 *
 * Coverage model (from web/site-integration/csp-hashes.txt and
 * DEPLOY-NOTE.md):
 *  - web/site-integration/bundle/ is the shipped S1 assistant bundle
 *    (deploys to <page-dir>/s1/ on movahedi.ca). The 14 sha256 entries in
 *    csp-hashes.txt cover its 13 first-party scripts plus the vendored
 *    onnxruntime bundle (accepted vendor exception, integrity-pinned).
 *  - Inline blocks (the window.T strings object and the S1 init block
 *    added by patches/0002-executor-wiring.patch) cannot be hashed from
 *    this repo: CSP hashes cover the element's exact text content including
 *    surrounding newlines, so they are recomputed from the FINAL built
 *    page bytes at deploy. csp-hashes.txt documents this procedure and
 *    carries a reference hash explicitly marked "recompute, never reuse
 *    blindly" (DEPLOY-NOTE.md section 3).
 *
 * Tests:
 *  1. every entry in csp-hashes.txt recomputes to the pinned value;
 *  2. every first-party script under web/site-integration/bundle has an
 *     entry (coverage in the other direction);
 *  3. the bundle copies are byte-identical to the source files under
 *     web/executor and web/chatbot (so the hashes pin the real sources);
 *  4. the inline-block hashing procedure is documented in the file.
 *
 * No em dashes.
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const WEB = path.resolve(__dirname, "..", "..", "web");
const BUNDLE = path.join(WEB, "site-integration", "bundle");
const HASHES = path.join(WEB, "site-integration", "csp-hashes.txt");

let n = 0;
function ok(cond, msg) { n++; assert.ok(cond, msg); }
function eq(a, b, msg) { n++; assert.strictEqual(a, b, msg); }

function sha256b64(buf) {
  return "sha256-" + crypto.createHash("sha256").update(buf).digest("base64");
}

function bundleJs() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "vendor") continue;
        walk(p);
        continue;
      }
      if (e.isFile() && e.name.endsWith(".js") && !e.name.endsWith(".test.js")) {
        out.push(path.relative(BUNDLE, p).replace(/\\/g, "/"));
      }
    }
  })(BUNDLE);
  return out.sort();
}

function main() {
  const text = fs.readFileSync(HASHES, "utf8");
  const entries = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(sha256-[A-Za-z0-9+/=]+)\s+#\s*(.+?)\s*$/);
    if (m) entries.push({ hash: m[1], label: m[2] });
  }
  ok(entries.length >= 14, "csp-hashes.txt carries at least 14 entries (got " + entries.length + ")");

  /* 1. every pinned hash recomputes from the bundle bytes. */
  const covered = new Set();
  let inlineDocs = 0;
  for (const e of entries) {
    const lm = e.label.match(/^s1\/((?:executor|chatbot)\/\S+?\.js)$/);
    if (!lm) {
      /* Inline-block reference hash: documented, recompute-only, no file
         to check in this repo (see section 4 below). */
      ok(/inline/i.test(e.label), "non-path entry is documented as inline: " + e.label.slice(0, 50));
      inlineDocs++;
      continue;
    }
    const rel = lm[1];
    const p = path.join(BUNDLE, rel);
    ok(fs.existsSync(p), "hashed file exists in the bundle: " + rel);
    eq(sha256b64(fs.readFileSync(p)), e.hash, "hash matches for " + rel);
    covered.add(rel);
  }

  /* The vendored ort bundle is the documented exception: pinned, not skipped. */
  ok(covered.has("executor/vendor/ort/ort.min.js"), "ort.min.js has a pinned hash entry");
  ok(inlineDocs >= 1, "the inline S1 init block carries a documented reference hash");

  /* 2. reverse coverage: every first-party bundle script has an entry. */
  const scripts = bundleJs();
  ok(scripts.length > 0, "bundle scripts found");
  for (const rel of scripts) {
    ok(covered.has(rel), "bundle script has a CSP hash entry: " + rel);
  }
  eq(covered.size, scripts.length + 1, "entries cover exactly the bundle scripts plus ort.min.js");

  /* 3. the bundle is byte-identical to the real sources. */
  const pairs = scripts.map((rel) => {
    const m = rel.match(/^(executor|chatbot)\/(js\/[^/]+\.js)$/);
    return m ? { bundle: rel, src: path.join(m[1], m[2]) } : null;
  }).filter(Boolean);
  ok(pairs.length === scripts.length, "every bundle script maps to a source file");
  for (const pr of pairs) {
    const a = fs.readFileSync(path.join(BUNDLE, pr.bundle));
    const b = fs.readFileSync(path.join(WEB, pr.src));
    ok(a.equals(b), "bundle copy is byte-identical to source: " + pr.src);
  }

  /* 4. inline-block coverage is documented, with a recompute rule. */
  ok(/final built page bytes/i.test(text), "inline hashing procedure is documented");
  ok(/window\.T/.test(text), "the window.T strings block is named");
  ok(/0002-executor-wiring/.test(text) || /init block/i.test(text), "the S1 init block is named");
  ok(/never reuse this value/i.test(text) || /recompute/i.test(text),
    "the reference hash is marked recompute-only");

  console.log("PASS " + n + " [csp-coverage]");
}

try {
  main();
} catch (e) {
  console.error("FAIL csp-coverage: " + (e && e.stack || e));
  process.exitCode = 1;
}
