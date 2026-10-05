"use strict";
/* xss.test.js - user-influenced strings must never become markup.
 *
 * Run: node tests/security/xss.test.js   (from the repo root)
 *
 * Where user strings reach the DOM (verified by reading the sources):
 *  - web/executor/js/ui.js: step log, review prompts, fix panel, trust bar.
 *    All writes go through el(tag, cls, text) which sets textContent.
 *  - web/chatbot/js/chatbot.js: chat bubbles via the same el() pattern.
 *  - web/executor/js/narrate.js: builds plain strings; the UI inserts them
 *    with textContent (see the integration test below).
 *  - web/canvas/canvas.js: node labels via t.textContent = def.label.
 *  - web/import/import.js: textContent everywhere; the only innerHTML uses
 *    are constant clears (innerHTML = "").
 *
 * Layers:
 *  A. Static: no HTML-string sinks with dynamic content in first-party JS.
 *     Every innerHTML assignment must be the constant empty clear; zero
 *     outerHTML / insertAdjacentHTML / document.write; no javascript: URLs;
 *     the only .href write is a.href = URL.createObjectURL(blob).
 *  B. Unit: Narr.narrate / Narr.reviewPrompt embed hostile labels in plain
 *     strings for a battery of vectors (script, img onerror, svg onload,
 *     javascript: URL, unicode escapes, fullwidth lookalikes).
 *  C. Integration: drive the REAL S1UI.init + enterReview() against a stub
 *     DOM with hostile node labels in the executor state. The stub records
 *     every textContent and innerHTML write. Assert no non-empty innerHTML
 *     write happened and each vector landed verbatim in textContent (i.e.
 *     it renders as text, never as markup).
 *  D. Chatbot recipe validator: hostile labels survive validation unchanged
 *     (validation must not transform or strip them; the DOM boundary is
 *     what neutralizes them).
 *
 * If a sink were genuinely unsafe, this file would report it as a finding
 * instead of asserting it safe. None was found.
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

const VECTORS = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "\"><svg onload=alert(1)>",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "\u003cscript\u003ealert(2)\u003c/script\u003e",
  "\uff1cscript\uff1ealert(3)\uff1c/script\uff1e",
  "'\"><iframe srcdoc=\"<script>alert(4)</script>\">",
];

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
      const h = crypto.createHash("sha256").update(buf).digest("hex");
      if (seen.has(h)) continue;
      seen.set(h, true);
      out.push({ rel: path.relative(WEB, p).replace(/\\/g, "/"), src: buf.toString("utf8") });
    }
  })(WEB);
  return out;
}

/* ---------------- stub DOM ---------------- */

const textWrites = [];
const htmlWrites = [];

function FakeElement(tag) {
  this.tagName = String(tag).toUpperCase();
  this.children = [];
  this.attributes = {};
  this.className = "";
  this._text = "";
  this._html = "";
  this.style = {};
  this.dataset = {};
  const self = this;
  this.classList = {
    add: function () {}, remove: function () {}, contains: function () { return false; },
  };
  Object.defineProperty(this, "textContent", {
    get: function () { return self._text; },
    set: function (v) { self._text = String(v); textWrites.push(String(v)); },
    configurable: true,
  });
  Object.defineProperty(this, "innerHTML", {
    get: function () { return self._html; },
    set: function (v) { self._html = String(v); htmlWrites.push(String(v)); },
    configurable: true,
  });
  Object.defineProperty(this, "firstChild", {
    get: function () { return self.children[0] || null; },
    configurable: true,
  });
}
FakeElement.prototype.setAttribute = function (k, v) { this.attributes[String(k)] = String(v); };
FakeElement.prototype.getAttribute = function (k) { return this.attributes[String(k)]; };
FakeElement.prototype.appendChild = function (c) { this.children.push(c); return c; };
FakeElement.prototype.removeChild = function (c) {
  const i = this.children.indexOf(c);
  if (i !== -1) this.children.splice(i, 1);
  return c;
};
FakeElement.prototype.addEventListener = function () {};
FakeElement.prototype.removeEventListener = function () {};
FakeElement.prototype.querySelector = function () { return null; };
FakeElement.prototype.querySelectorAll = function () { return []; };
FakeElement.prototype.focus = function () {};
FakeElement.prototype.scrollIntoView = function () {};
FakeElement.prototype.click = function () {};
FakeElement.prototype.remove = function () {};

function main() {
  /* ---------------- A. static sink scan ---------------- */
  const files = firstPartyJs();
  ok(files.length >= 20, "scanned first-party files (got " + files.length + ")");

  const badHtml = [];
  const badJsScheme = [];
  for (const f of files) {
    const lines = f.src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (/\.outerHTML\s*=/.test(ln) || /insertAdjacentHTML/.test(ln) || /document\.write/.test(ln)) {
        badHtml.push(f.rel + ":" + (i + 1));
      }
      const im = ln.match(/\.innerHTML\s*=\s*([^;]+);/);
      if (im && im[1].trim() !== '""' && im[1].trim() !== "''") {
        badHtml.push(f.rel + ":" + (i + 1) + " non-constant innerHTML: " + im[1].trim().slice(0, 60));
      }
      if (/["']javascript:/i.test(ln)) badJsScheme.push(f.rel + ":" + (i + 1));
    }
  }
  eq(badHtml.length, 0, "no dynamic HTML sinks (found: " + badHtml.join("; ") + ")");
  eq(badJsScheme.length, 0, "no javascript: URLs (found: " + badJsScheme.join("; ") + ")");

  /* The only .href write is the blob download; the only .download write
     takes a literal filename (asserted in path-traversal.test.js too). */
  const hrefWrites = [];
  for (const f of files) {
    const m = f.src.match(/[a-zA-Z_$][\w$]*\.href\s*=\s*[^;]+;/g) || [];
    m.forEach((x) => hrefWrites.push(f.rel + ": " + x.trim()));
  }
  ok(hrefWrites.length > 0, "found .href writes to classify");
  hrefWrites.forEach((w) => ok(/URL\.createObjectURL\(blob\)/.test(w), "href write is a blob URL: " + w));

  /* canvas.js renders labels with textContent, never innerHTML. */
  const canvas = files.find((f) => f.rel === "canvas/canvas.js");
  ok(!!canvas, "canvas.js found");
  ok(/t\.textContent\s*=\s*def\.label/.test(canvas.src), "canvas label sink is textContent");
  ok(!/innerHTML/.test(canvas.src), "canvas.js has no innerHTML at all");

  /* ui.js bloom() builds a querySelector from nodeId; node ids are forced
     to the n<seq> shape by the executor, so no quote breakout is possible. */
  const apply = files.find((f) => f.rel === "executor/js/apply.js");
  ok(!!apply, "apply.js found");
  ok(/var expected = "n" \+ \(this\._seq \+ 1\)/.test(apply.src), "node ids are sequence-forced (n<seq>)");
  ok(/p\.node_id !== expected/.test(apply.src), "out-of-sequence node ids are rejected");

  /* ---------------- B. narration units ---------------- */
  const Narr = require(path.join(WEB, "executor/js/narrate.js"));
  for (const v of VECTORS) {
    const t = Narr.narrate("add_node", { type: "system" }, null, { label: v });
    ok(typeof t.en === "string" && t.en.indexOf(v) !== -1, "narrate en embeds label verbatim: " + v.slice(0, 24));
    ok(typeof t.fr === "string" && t.fr.indexOf(v) !== -1, "narrate fr embeds label verbatim: " + v.slice(0, 24));
    const rp = Narr.reviewPrompt("node", { label: v, type: "system" }, "en");
    ok(rp.indexOf(v) !== -1, "reviewPrompt embeds label verbatim: " + v.slice(0, 24));
    const rpEdge = Narr.reviewPrompt("edge", { cat: "contact", a_label: v, b_label: "ok" }, "en");
    ok(rpEdge.indexOf(v) !== -1, "edge reviewPrompt embeds label verbatim: " + v.slice(0, 24));
  }

  /* ---------------- C. integration through S1UI ---------------- */
  const Tok = require(path.join(WEB, "executor/js/s1tokenize.js")); global.S1Tokenize = Tok;
  const U = require(path.join(WEB, "executor/js/s1util.js")); global.S1Util = U;
  global.S1Templates = require(path.join(WEB, "executor/js/templates.js"));
  global.S1Narrate = Narr;
  global.S1Review = require(path.join(WEB, "executor/js/review.js"));
  global.S1Exporter = require(path.join(WEB, "executor/js/exporter.js"));
  global.S1I18n = require(path.join(WEB, "executor/js/i18n.js"));
  global.__s1net = { count: function () { return 0; } };

  const host = new FakeElement("div");
  global.document = {
    createElement: function (tag) { return new FakeElement(tag); },
    createElementNS: function (ns, tag) { return new FakeElement(tag); },
    getElementById: function () { return host; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    activeElement: null,
    body: new FakeElement("body"),
  };
  const timers = [];
  global.setInterval = function () { timers.push(1); return timers.length; };
  const realClearInterval = global.clearInterval;
  global.clearInterval = function () {};

  const fakeNodes = {};
  VECTORS.forEach((v, i) => {
    fakeNodes["n" + (i + 1)] = { type: "system", x: 100 + i * 10, y: 100, label: v };
  });
  const fakeEx = {
    _nodes: fakeNodes,
    _edges: [{ a: "n1", b: "n2", cat: "contact" }],
    _annotations: [],
    _items: [],
  };
  global.S1Executor = {
    hooks: { setLang: function () {}, controller: { executor: function () { return fakeEx; } } },
  };

  const S1UI = require(path.join(WEB, "executor/js/ui.js"));
  const ui = S1UI.init({ rootId: "s1-assistant", lang: "en" });
  ok(!!ui, "S1UI.init returned a handle");
  ok(ui.enterReview() === true, "enterReview ran the review render");

  timers.forEach((id) => realClearInterval(id));

  const nonEmptyHtml = htmlWrites.filter((w) => w !== "");
  eq(nonEmptyHtml.length, 0, "no non-empty innerHTML write during init+review (got " + nonEmptyHtml.length + ")");
  ok(textWrites.length > 50, "textContent writes observed (got " + textWrites.length + ")");
  for (const v of VECTORS) {
    ok(textWrites.some((w) => w.indexOf(v) !== -1),
      "vector rendered via textContent (verbatim text, not markup): " + v.slice(0, 30));
  }

  /* ---------------- D. chatbot validator preserves labels ---------------- */
  const Chat = require(path.join(WEB, "chatbot/js/chatbot.js"));
  for (const v of VECTORS) {
    const r = Chat.pure.validateRecipeText(JSON.stringify({
      recipe_id: "xss-probe", schema_version: "1.0.0",
      items: [{ intent: "add_node", params: { node_id: "n1", type: "system", x: 100, y: 100, label: v } }],
    }), "en");
    ok(r.ok === true, "hostile label passes structural validation: " + v.slice(0, 24));
    eq(r.recipe.items[0].params.label, v, "validator preserves the label unchanged: " + v.slice(0, 24));
  }

  console.log("PASS " + n + " [xss]");
}

try {
  main();
} catch (e) {
  console.error("FAIL xss: " + (e && e.stack || e));
  process.exitCode = 1;
}
