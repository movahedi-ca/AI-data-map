"use strict";
/* dependency-hygiene.test.js - vendored bundles are pinned; no dynamic code.
 *
 * Run: node tests/security/dependency-hygiene.test.js   (from the repo root)
 *
 * Vendor layout (verified by reading the repo):
 *  - web/import/vendor/: SheetJS xlsx.full.min.js, pinned in the sibling
 *    SHA256SUMS file.
 *  - web/executor/vendor/: onnxruntime-web 1.20.1 (ort.min.js, the wasm
 *    sidecars) + the s1-workflow-tiny model files. Hashes are pinned in
 *    VENDOR-MANIFEST.md; the deploy bundle copies are pinned again in
 *    web/site-integration/SHA256SUMS.
 *
 * Tests:
 *  1. every file under web/import/vendor and web/executor/vendor (recursive)
 *     has a pinned sha256 in one of those sources, and the recomputed hash
 *     matches;
 *  2. the bundle copies under web/site-integration/bundle are byte-identical
 *     to the vendor originals, and their SHA256SUMS entries match;
 *  3. the in-browser model gate (executor.js MODEL_SHA256) equals the
 *     manifest's pinned model.onnx hash;
 *  4. no eval( and no new Function( in first-party JS (vendor/ excluded by
 *     definition; tests excluded).
 *
 * Note: web/chatbot/js/chatbot.js contains one bare Function("return this")()
 * call (a global-object fallback reached only when both self and window are
 * undefined, i.e. never in a browser). It is not eval( / new Function(, but
 * it is dynamic code compilation and is reported here for completeness.
 *
 * No em dashes.
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const WEB = path.resolve(__dirname, "..", "..", "web");

let n = 0;
function ok(cond, msg) { n++; assert.ok(cond, msg); }
function eq(a, b, msg) { n++; assert.strictEqual(a, b, msg); }

function sha256hex(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

function walkFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.isFile()) out.push(p);
    }
  })(dir);
  return out.sort();
}

function parseSumsFile(p) {
  const map = new Map();
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([0-9a-f]{64})\s+(.+?)\s*$/);
    if (m) map.set(m[2], m[1]);
  }
  return map;
}

function firstPartyJs() {
  const seen = new Map();
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "vendor") continue;
        walk(p);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith(".js") || e.name.endsWith(".test.js")) continue;
      const buf = fs.readFileSync(p);
      const h = sha256hex(buf);
      if (seen.has(h)) continue;
      seen.set(h, true);
      out.push({ rel: path.relative(WEB, p).replace(/\\/g, "/"), src: buf.toString("utf8") });
    }
  })(WEB);
  return out;
}

function main() {
  /* ---- 1. vendor pins ---- */
  const importSums = parseSumsFile(path.join(WEB, "import/vendor/SHA256SUMS"));
  const siteSums = parseSumsFile(path.join(WEB, "site-integration/SHA256SUMS"));
  const manifest = fs.readFileSync(path.join(WEB, "executor/vendor/VENDOR-MANIFEST.md"), "utf8");
  const manifestHashes = new Set(manifest.match(/[0-9a-f]{64}/g) || []);
  ok(manifestHashes.size >= 5, "VENDOR-MANIFEST.md pins at least 5 hashes");

  const vendorFiles = walkFiles(path.join(WEB, "import/vendor"))
    .concat(walkFiles(path.join(WEB, "executor/vendor")))
    .filter((p) => {
      const b = path.basename(p);
      return b !== "SHA256SUMS" && b !== "VENDOR-MANIFEST.md" && !b.endsWith(".txt");
    });
  ok(vendorFiles.length >= 6, "vendored files found (got " + vendorFiles.length + ")");

  for (const p of vendorFiles) {
    const rel = path.relative(WEB, p).replace(/\\/g, "/");
    const base = path.basename(p);
    const hex = sha256hex(fs.readFileSync(p));
    if (rel.indexOf("import/vendor/") === 0) {
      ok(importSums.has(base), "import vendor file pinned in SHA256SUMS: " + base);
      eq(importSums.get(base), hex, "hash matches for " + base);
    } else {
      ok(manifestHashes.has(hex), "executor vendor file pinned in VENDOR-MANIFEST.md: " + rel);
    }
  }

  /* ---- 2. bundle copies are identical and pinned ---- */
  const bundleVendor = [
    "executor/vendor/ort/ort.min.js",
    "executor/vendor/ort/ort-wasm-simd-threaded.mjs",
    "executor/vendor/ort/ort-wasm-simd-threaded.wasm",
    "executor/vendor/model/model.onnx",
    "executor/vendor/model/model.onnx.data",
  ];
  for (const rel of bundleVendor) {
    const orig = fs.readFileSync(path.join(WEB, rel));
    const copy = path.join(WEB, "site-integration/bundle", rel);
    ok(fs.existsSync(copy), "bundle copy exists: " + rel);
    ok(orig.equals(fs.readFileSync(copy)), "bundle copy byte-identical: " + rel);
    const key = "bundle/" + rel;
    ok(siteSums.has(key), "SHA256SUMS entry exists for " + key);
    eq(siteSums.get(key), sha256hex(orig), "SHA256SUMS hash matches for " + key);
  }

  /* ---- 3. the in-browser model gate pins the same hash ---- */
  const execSrc = fs.readFileSync(path.join(WEB, "executor/js/executor.js"), "utf8");
  const mm = execSrc.match(/var MODEL_SHA256 = "([0-9a-f]{64})"/);
  ok(!!mm, "MODEL_SHA256 constant found in executor.js");
  const modelHex = sha256hex(fs.readFileSync(path.join(WEB, "executor/vendor/model/model.onnx")));
  eq(mm[1], modelHex, "MODEL_SHA256 equals the vendored model.onnx hash");
  ok(manifestHashes.has(mm[1]), "MODEL_SHA256 is also pinned in VENDOR-MANIFEST.md");

  /* ---- 4. no dynamic code compilation in first-party JS ---- */
  const files = firstPartyJs();
  ok(files.length >= 20, "scanned first-party files (got " + files.length + ")");
  const evalHits = [];
  const newFnHits = [];
  const bareFnHits = [];
  for (const f of files) {
    const lines = f.src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (/\beval\s*\(/.test(ln)) evalHits.push(f.rel + ":" + (i + 1));
      if (/\bnew\s+Function\s*\(/.test(ln)) newFnHits.push(f.rel + ":" + (i + 1));
      if (/(^|[^\w$])Function\s*\(/.test(ln) && !/\bnew\s+Function\s*\(/.test(ln)) {
        bareFnHits.push(f.rel + ":" + (i + 1) + ": " + ln.trim().slice(0, 70));
      }
    }
  }
  eq(evalHits.length, 0, "no eval( in first-party JS (found: " + evalHits.join("; ") + ")");
  eq(newFnHits.length, 0, "no new Function( in first-party JS (found: " + newFnHits.join("; ") + ")");
  if (bareFnHits.length) {
    console.log("INFO: bare Function( occurrences (not eval/new Function):");
    bareFnHits.forEach((h) => console.log("INFO:   " + h));
  }

  console.log("PASS " + n + " [dependency-hygiene]");
}

try {
  main();
} catch (e) {
  console.error("FAIL dependency-hygiene: " + (e && e.stack || e));
  process.exitCode = 1;
}
