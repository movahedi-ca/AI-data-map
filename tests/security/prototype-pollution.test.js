"use strict";
/* prototype-pollution.test.js - hostile keys must not pollute Object.prototype.
 *
 * Run: node tests/security/prototype-pollution.test.js   (from the repo root)
 *
 * JSON merge/deep-extend paths in first-party code (verified by reading):
 *  - web/executor/js/s1tokenize.js parseJsonFields(): hand-written JSON
 *    parser; parseObject() does obj[key] = parseValue() with an
 *    attacker-controlled key. For "__proto__" this mutates the parsed
 *    object's own prototype (NOT the global Object.prototype).
 *    => REAL FINDING (reported, not fixed; sources are read-only here).
 *       The required property still holds: ({}).polluted stays undefined.
 *  - web/executor/js/s1util.js deepCopy(): JSON.parse(JSON.stringify(v)).
 *    JSON.parse materializes "__proto__" as an own data property without
 *    invoking the setter, so the copy is clean. Safe.
 *  - web/chatbot/js/chatbot.js validateRecipeText(): JSON.parse only, the
 *    recipe object is used structurally. Safe.
 *  - web/import/import.js Object.assign({}, m.mapping): mapping keys are
 *    frozen field enums from column-mapper's matchHeader (never raw header
 *    text), so no attacker key reaches the merge. Safe (asserted below).
 *
 * Tests assert ({}).polluted === undefined after every hostile merge, plus
 * the positive safety properties of each path.
 *
 * No em dashes.
 */
global.self = global;

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const WEB = path.resolve(__dirname, "..", "..", "web");

let n = 0;
function ok(cond, msg) { n++; assert.ok(cond, msg); }
function eq(a, b, msg) { n++; assert.strictEqual(a, b, msg); }

const PROTO = Object.prototype;

function main() {
  const Tok = require(path.join(WEB, "executor/js/s1tokenize.js")); global.S1Tokenize = Tok;
  const U = require(path.join(WEB, "executor/js/s1util.js")); global.S1Util = U;
  global.S1I18n = require(path.join(WEB, "executor/js/i18n.js"));
  const Chat = require(path.join(WEB, "chatbot/js/chatbot.js"));

  /* ---- 1. parseJsonFields: global prototype must stay clean ---- */
  const payloads = [
    '{"__proto__": {"polluted": "p1"}}',
    '{"a": {"__proto__": {"polluted": "p2"}}}',
    '{"__proto__": {"polluted": "p3"}, "b": [{"__proto__": {"polluted": "p4"}}]}',
    '{"constructor": {"prototype": {"polluted": "p5"}}}',
    '{"a": 1, "__proto__": null}',
  ];
  for (const body of payloads) {
    Tok.parseJsonFields(body);
    eq(({}).polluted, undefined, "Object.prototype clean after parseJsonFields(" + body.slice(0, 30) + ")");
  }
  eq(PROTO.polluted, undefined, "Object.prototype.polluted is undefined");

  /* The parsed value itself is usable: normal keys survive. */
  const parsed = Tok.parseJsonFields('{"x": 40, "label": "CRM"}');
  eq(parsed.label, "CRM", "ordinary parse result intact");

  /* Even a proto-tainted parse result becomes clean through deepCopy:
     JSON.stringify only serializes own properties, so the mutated
     prototype's members do not survive the round trip. */
  const tainted = Tok.parseJsonFields('{"__proto__": {"polluted": "p6"}, "label": "CRM"}');
  const clean = U.deepCopy(tainted);
  eq(Object.getPrototypeOf(clean), PROTO, "deepCopy result has the normal prototype");
  eq(({}).polluted, undefined, "still clean after copying the tainted value");
  eq(clean.label, "CRM", "deepCopy preserves real data");

  /* ---- 2. deepCopy direct ---- */
  const viaJson = JSON.parse('{"__proto__": {"polluted": "d1"}, "ok": true}');
  const dc = U.deepCopy(viaJson);
  eq(({}).polluted, undefined, "Object.prototype clean after deepCopy of proto payload");
  eq(Object.getPrototypeOf(dc), PROTO, "deepCopy result prototype is Object.prototype");
  eq(dc.ok, true, "deepCopy keeps ordinary keys");
  ok(!("polluted" in dc) || dc.polluted === undefined, "no polluted member on the copy");

  /* ---- 3. chatbot recipe validator ---- */
  const recipe = {
    recipe_id: "pp-probe", schema_version: "1.0.0",
    items: [{
      intent: "set_field",
      params: { node_id: "n1", field: "label", value: "x", __proto__: { polluted: "r1" } },
    }],
  };
  const r = Chat.pure.validateRecipeText(JSON.stringify(recipe), "en");
  eq(({}).polluted, undefined, "Object.prototype clean after validating a proto-keyed recipe");
  eq(Object.getPrototypeOf(r.recipe), PROTO, "validated recipe has the normal prototype");

  /* ---- 4. import column mapping: keys are frozen enums ---- */
  const cmSrc = fs.readFileSync(path.join(WEB, "import/engine/column-mapper.js"), "utf8");
  const writes = cmSrc.match(/mapping\[[^\]]+\]\s*=/g) || [];
  ok(writes.length > 0, "found mapping writes to classify");
  writes.forEach((w) => {
    ok(/mapping\[field\]/.test(w), "mapping key is the matchHeader() result, not raw header text: " + w);
  });
  ok(/function matchHeader/.test(cmSrc), "matchHeader defined in column-mapper.js");
  /* matchHeader returns null or a member of the frozen alias sets. */
  ok(/return null/.test(cmSrc), "matchHeader can return null for unknown headers");

  /* Object.assign over an enum-keyed mapping cannot plant __proto__. */
  const m = { label: 0, type: 1 };
  const merged = Object.assign({}, m);
  eq(Object.getPrototypeOf(merged), PROTO, "Object.assign over enum keys keeps the normal prototype");
  eq(({}).polluted, undefined, "clean after the enum-keyed merge");

  /* ---- 5. review.js confirmedNodes: key comes from recipe params ---- */
  const Rev = require(path.join(WEB, "executor/js/review.js"));
  const rows = Rev.deriveChecklist({
    _nodes: { n1: { type: "system", x: 100, y: 100, label: "CRM" } },
    _edges: [],
    _annotations: [],
    _items: [{ intent: "confirm_node", params: { node_id: "__proto__" } }],
  });
  eq(({}).polluted, undefined, "Object.prototype clean after a hostile confirm_node id");
  eq(rows[0].status, "unconfirmed", "hostile id does not confirm the real node");

  console.log("PASS " + n + " [prototype-pollution]");
}

try {
  main();
} catch (e) {
  console.error("FAIL prototype-pollution: " + (e && e.stack || e));
  process.exitCode = 1;
}
