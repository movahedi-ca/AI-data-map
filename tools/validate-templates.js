#!/usr/bin/env node
/**
 * validate-templates.js - Phase 7 template validation.
 *
 * Node stdlib only. Checks every template in data/templates.json:
 *   1. Structural conformance to specs/recipe-schema.json (hand-rolled,
 *      mirroring the schema's per-intent rules).
 *   2. Every intent is one of the 9 authoring intents (no recovery intents).
 *   3. Retention rule: ranges with cited statutes or verify_only; Law 25
 *      never sources a number; as_of within range.
 *   4. Chip round-trip: all 384 vectors resolve through
 *      web/executor/js/templates.js selectTemplate to the right recipe_id;
 *      embedded table deep-equals data/templates.json.
 *   5. authoredTemplates() lists 384; validateChips behaves.
 *   6. The 3 Phase 6 skeletons are byte-identical to the pre-Phase-7 file.
 *   7. No timestamps, no em dashes in generated artifacts.
 *   8. Byte-reproducibility: re-running the generator changes nothing.
 *
 * Exit 0 when everything passes; non-zero with a failure report.
 * No em dashes anywhere in this file.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var childProcess = require("child_process");

var ROOT = path.resolve(__dirname, "..");
var DATA_JSON = path.join(ROOT, "data", "templates.json");
var TEMPLATES_JS = path.join(ROOT, "web", "executor", "js", "templates.js");
var GENERATOR = path.join(ROOT, "tools", "generate-templates.js");
var ORIG3 = "/tmp/phase7-orig3.json";

var failures = [];
function fail(msg) {
  failures.push(msg);
}

var AUTHORING_INTENTS = [
  "add_node", "add_collection_point", "connect", "set_field",
  "set_retention", "confirm_node", "flag_for_review",
  "run_check", "export"
];
var RECOVERY_INTENTS = ["undo_last", "skip_recipe_item", "abort_session"];
var NODE_TYPES = ["collection", "system", "thirdparty", "destruction"];
var EDGE_CATS = ["contact", "payment", "marketing"];
var ALL_CHECKS = ["label_coverage", "connectivity", "retention_cited", "edge_categories"];
var NODE_ID_RE = /^n[1-9]\d*$/;
var AS_OF_RE = /^\d{4}-\d{2}-\d{2}$/;
var SECTION_RE = /([Ss][Ss]?\.?\s*[0-9]+|[Aa][Rr][Tt]\.?\s*[0-9]+|[Aa][Rr][Tt][Ii][Cc][Ll][Ee]\s+[0-9]+|[Rr]\.?\s*[0-9]+(\.[0-9]+)*|\u00a7\s*[0-9]+)/;
var LAW25_RE = /([Ll][Aa][Ww]\s*25|[Ll][Oo][Ii]\s*25|[Bb][Ii][Ll][Ll]\s*64|[Ll][Pp][Rr][Pp][Ss][Pp]|[Mm][Oo][Dd][Ee][Rr][Nn][Ii][Ss][Aa][Nn][Tt]|[Rr][Ee][Nn][Ss][Ee][Ii][Gg][Nn][Ee][Mm][Ee][Nn][Tt][Ss]\s+[Pp][Ee][Rr][Ss][Oo][Nn][Nn][Ee][Ll][Ss])/;
var TODAY = "2026-10-05";

function extraKeys(obj, allowed) {
  return Object.keys(obj).filter(function (k) { return allowed.indexOf(k) === -1; });
}

function checkParams(rid, idx, params, allowed, required) {
  var ex = extraKeys(params, allowed);
  if (ex.length) fail(rid + " item " + idx + ": extra params " + ex.join(","));
  required.forEach(function (k) {
    if (!(k in params)) fail(rid + " item " + idx + ": missing param " + k);
  });
}

function validNode(id, rid, idx) {
  if (!NODE_ID_RE.test(id)) fail(rid + " item " + idx + ": bad node id " + id);
}
function validXY(p, rid, idx) {
  if (typeof p.x !== "number" || p.x < 40 || p.x > 600) fail(rid + " item " + idx + ": x out of range");
  if (typeof p.y !== "number" || p.y < 40 || p.y > 380) fail(rid + " item " + idx + ": y out of range");
}
function validLabel(label, rid, idx) {
  if (typeof label !== "string" || label.length < 1 || label.length > 200) {
    fail(rid + " item " + idx + ": label length out of range");
  }
}

/* Structural validation of one template, mirroring recipe-schema.json. */
function validateTemplate(t, key) {
  var rid = t.recipe_id;
  var n = 0;

  if (!/^[A-Za-z0-9_-]+$/.test(rid) || rid.length > 128) fail(key + ": bad recipe_id");
  if (!/^1\.0\.\d+$/.test(t.schema_version)) fail(rid + ": bad schema_version");
  if (typeof t.name !== "string" || t.name.length === 0 || t.name.length > 200) fail(rid + ": bad name");
  if (!Array.isArray(t.items) || t.items.length < 1 || t.items.length > 512) {
    fail(rid + ": items not a non-empty list");
    return n;
  }

  var nodes = {};   /* node_id -> {type} */
  var seq = 0;
  var edges = [];
  var edgePairs = {};
  var retention = {};

  t.items.forEach(function (it, idx) {
    var p = it.params || {};
    if (AUTHORING_INTENTS.indexOf(it.intent) === -1) {
      fail(rid + " item " + idx + ": intent not in authoring set: " + it.intent);
      return;
    }
    if (RECOVERY_INTENTS.indexOf(it.intent) !== -1) {
      fail(rid + " item " + idx + ": recovery intent must not appear in authored recipe");
    }
    switch (it.intent) {
      case "add_collection_point":
        checkParams(rid, idx, p, ["node_id", "x", "y", "label"], ["node_id", "x", "y", "label"]);
        validNode(p.node_id, rid, idx); validXY(p, rid, idx); validLabel(p.label, rid, idx);
        seq++;
        if (p.node_id !== "n" + seq) fail(rid + " item " + idx + ": node id out of sequence (want n" + seq + ")");
        nodes[p.node_id] = { type: "collection" };
        break;
      case "add_node":
        checkParams(rid, idx, p, ["node_id", "type", "x", "y", "label"], ["node_id", "type", "x", "y", "label"]);
        validNode(p.node_id, rid, idx); validXY(p, rid, idx); validLabel(p.label, rid, idx);
        if (NODE_TYPES.indexOf(p.type) === -1) fail(rid + " item " + idx + ": bad node type");
        seq++;
        if (p.node_id !== "n" + seq) fail(rid + " item " + idx + ": node id out of sequence (want n" + seq + ")");
        nodes[p.node_id] = { type: p.type };
        break;
      case "connect":
        checkParams(rid, idx, p, ["a", "b", "cat"], ["a", "b", "cat"]);
        validNode(p.a, rid, idx); validNode(p.b, rid, idx);
        if (!(p.a in nodes)) fail(rid + " item " + idx + ": unknown node " + p.a);
        if (!(p.b in nodes)) fail(rid + " item " + idx + ": unknown node " + p.b);
        if (p.a === p.b) fail(rid + " item " + idx + ": self-loop");
        if (EDGE_CATS.indexOf(p.cat) === -1) fail(rid + " item " + idx + ": bad edge cat");
        var pair = [p.a, p.b].sort().join("<>");
        if (edgePairs[pair]) fail(rid + " item " + idx + ": duplicate edge pair");
        edgePairs[pair] = true;
        edges.push(p);
        break;
      case "set_retention":
        checkParams(rid, idx, p,
          ["node_id", "record_type", "range_min_years", "range_max_years", "statute", "as_of", "anchor", "verify_only"],
          p.verify_only === true ? ["node_id", "record_type", "as_of"] : ["node_id", "record_type", "range_min_years", "range_max_years", "statute", "as_of"]);
        validNode(p.node_id, rid, idx);
        if (!(p.node_id in nodes)) fail(rid + " item " + idx + ": retention on unknown node");
        if (typeof p.record_type !== "string" || p.record_type.length < 1 || p.record_type.length > 120) {
          fail(rid + " item " + idx + ": bad record_type");
        }
        if (!AS_OF_RE.test(p.as_of || "") || p.as_of > TODAY) fail(rid + " item " + idx + ": bad as_of");
        if (p.verify_only === true) {
          if ("range_min_years" in p || "range_max_years" in p || "statute" in p) {
            fail(rid + " item " + idx + ": verify_only must not carry a range or statute");
          }
        } else {
          if (!(p.range_min_years > 0) || !(p.range_max_years > p.range_min_years)) {
            fail(rid + " item " + idx + ": bad retention range");
          }
          if (typeof p.statute !== "string" || p.statute.length < 8 || p.statute.length > 300) {
            fail(rid + " item " + idx + ": bad statute");
          }
          if (!SECTION_RE.test(p.statute)) fail(rid + " item " + idx + ": statute names no section");
          if (LAW25_RE.test(p.statute)) fail(rid + " item " + idx + ": Law 25 cited as retention source");
        }
        if (p.anchor !== undefined && (typeof p.anchor !== "string" || p.anchor.length > 120)) {
          fail(rid + " item " + idx + ": bad anchor");
        }
        retention[p.node_id] = true;
        break;
      case "confirm_node":
        checkParams(rid, idx, p, ["node_id", "note"], ["node_id"]);
        validNode(p.node_id, rid, idx);
        if (!(p.node_id in nodes)) fail(rid + " item " + idx + ": confirm on unknown node");
        if (p.note !== undefined && (typeof p.note !== "string" || p.note.length > 500)) {
          fail(rid + " item " + idx + ": bad note");
        }
        break;
      case "flag_for_review":
        checkParams(rid, idx, p, ["node_id", "item_index", "reason"], ["reason"]);
        if (!("node_id" in p) && !("item_index" in p)) fail(rid + " item " + idx + ": flag needs a target");
        if (p.node_id !== undefined) {
          validNode(p.node_id, rid, idx);
          if (!(p.node_id in nodes)) fail(rid + " item " + idx + ": flag on unknown node");
        }
        if (p.item_index !== undefined && (!Number.isInteger(p.item_index) || p.item_index < 0)) {
          fail(rid + " item " + idx + ": bad item_index");
        }
        if (typeof p.reason !== "string" || p.reason.length < 1 || p.reason.length > 500) {
          fail(rid + " item " + idx + ": bad reason");
        }
        break;
      case "run_check":
        checkParams(rid, idx, p, ["checks"], ["checks"]);
        if (!Array.isArray(p.checks) || p.checks.length < 1) fail(rid + " item " + idx + ": checks empty");
        var seen = {};
        (p.checks || []).forEach(function (c) {
          if (ALL_CHECKS.indexOf(c) === -1) fail(rid + " item " + idx + ": unknown check " + c);
          if (seen[c]) fail(rid + " item " + idx + ": duplicate check " + c);
          seen[c] = true;
        });
        if (p.checks.length !== 4) fail(rid + " item " + idx + ": run_check must carry all four checks");
        break;
      case "export":
        checkParams(rid, idx, p, ["format"], ["format"]);
        if (p.format !== "xls") fail(rid + " item " + idx + ": export format must be xls");
        break;
      case "set_field":
        checkParams(rid, idx, p, ["node_id", "field", "value"], ["node_id", "field", "value"]);
        validNode(p.node_id, rid, idx);
        if (["label", "x", "y"].indexOf(p.field) === -1) fail(rid + " item " + idx + ": bad field");
        break;
      default:
        fail(rid + " item " + idx + ": unhandled intent " + it.intent);
    }
    n++;
  });

  /* Cross-item invariants. */
  var nodeIds = Object.keys(nodes);
  nodeIds.forEach(function (nid) {
    var ty = nodes[nid].type;
    if (ty === "system" || ty === "thirdparty") {
      if (!retention[nid]) fail(rid + ": node " + nid + " (" + ty + ") lacks retention (retention_cited)");
    }
  });
  nodeIds.forEach(function (nid) {
    var inEdge = edges.some(function (e) { return e.a === nid || e.b === nid; });
    if (!inEdge && nodes[nid].type !== "destruction") fail(rid + ": node " + nid + " has no edge (connectivity)");
  });
  nodeIds.forEach(function (nid) {
    if (nodes[nid].type === "collection") {
      var ok = edges.some(function (e) {
        return (e.a === nid && nodes[e.b].type === "system") || (e.b === nid && nodes[e.a].type === "system");
      });
      if (!ok) fail(rid + ": collection node " + nid + " has no edge to a system (connectivity)");
    }
  });

  /* Every template ends with run_check (four checks) then export. */
  var lastTwo = t.items.slice(-2).map(function (it) { return it.intent; });
  if (lastTwo.join(",") !== "run_check,export") fail(rid + ": must end with run_check then export");

  return n;
}

/* ------------------------------------------------------------------ */

function main() {
  var doc = JSON.parse(fs.readFileSync(DATA_JSON, "utf8"));
  var keys = Object.keys(doc.templates).sort();
  console.log("templates in data/templates.json: " + keys.length);
  if (keys.length !== 384) fail("expected 384 templates, found " + keys.length);

  var SIZES = ["1-10", "11-50", "51-200", "200+"];
  var SECTORS = ["retail", "services", "health", "tech", "manufacturing", "nonprofit"];
  var REGIONS = ["quebec", "canada", "canada-us", "international"];
  var TYPES = ["contact", "contact-payment", "contact-marketing", "all"];
  var REGION_SHORT = { quebec: "qc", canada: "ca", "canada-us": "caus", international: "intl" };
  var SIZE_IDX = { "1-10": 1, "11-50": 2, "51-200": 3, "200+": 4 };

  var expected = {};
  SIZES.forEach(function (s) {
    SECTORS.forEach(function (sec) {
      REGIONS.forEach(function (r) {
        TYPES.forEach(function (ty) {
          var k = [s, sec, r, ty].join("|");
          expected[k] = "t-" + SIZE_IDX[s] + "-" + sec + "-" + REGION_SHORT[r] + "-" + ty + "-01";
        });
      });
    });
  });

  var schemaOk = 0;
  keys.forEach(function (k) {
    var t = doc.templates[k];
    if (!expected[k]) { fail("unexpected key " + k); return; }
    if (t.recipe_id !== expected[k]) fail(k + ": recipe_id " + t.recipe_id + " != " + expected[k]);
    var c = t.chips || {};
    if (k !== [c.size, c.sector, c.region, c.types].join("|")) fail(k + ": chips do not match key");
    validateTemplate(t, k);
    schemaOk++;
  });
  console.log("schema-valid templates: " + schemaOk + "/384");

  /* Chip round-trip through the shipped templates.js. */
  var S1Templates = require(TEMPLATES_JS);
  var roundOk = 0;
  keys.forEach(function (k) {
    var parts = k.split("|");
    var chips = { size: parts[0], sector: parts[1], region: parts[2], types: parts[3] };
    var problems = S1Templates.validateChips(chips);
    if (problems.length) { fail(k + ": validateChips rejects a valid vector"); return; }
    var t = S1Templates.selectTemplate(chips);
    if (!t) { fail(k + ": selectTemplate returned null"); return; }
    if (t.recipe_id !== expected[k]) { fail(k + ": round-trip recipe_id " + t.recipe_id); return; }
    if ("chips" in t) { fail(k + ": selectTemplate leaks chips metadata"); return; }
    var want = JSON.parse(JSON.stringify(doc.templates[k]));
    delete want.chips;
    if (JSON.stringify(t) !== JSON.stringify(want)) { fail(k + ": selectTemplate content differs from templates.json"); return; }
    roundOk++;
  });
  console.log("chip round-trips: " + roundOk + "/384");

  var listed = S1Templates.authoredTemplates();
  if (listed.length !== 384) fail("authoredTemplates() lists " + listed.length + ", want 384");
  listed.forEach(function (e) {
    if (!e.recipe_id || !e.name || !e.chips || typeof e.items !== "number") {
      fail("authoredTemplates entry malformed: " + JSON.stringify(e).slice(0, 80));
    }
  });
  if (S1Templates.validateChips({ size: "xx", sector: "retail", region: "quebec", types: "contact" }).length === 0) {
    fail("validateChips accepts an invalid size");
  }

  /* Nearest fallback sanity: an invalid vector still resolves deterministically. */
  var fb1 = S1Templates.selectTemplate({ size: "xx", sector: "retail", region: "quebec", types: "contact" });
  var fb2 = S1Templates.selectTemplate({ size: "xx", sector: "retail", region: "quebec", types: "contact" });
  if (!fb1 || JSON.stringify(fb1) !== JSON.stringify(fb2)) fail("nearest fallback not deterministic");

  /* The 3 Phase 6 skeletons byte-identical. */
  if (fs.existsSync(ORIG3)) {
    var orig = JSON.parse(fs.readFileSync(ORIG3, "utf8"));
    Object.keys(orig).forEach(function (k) {
      var now = S1Templates.selectTemplate({
        size: k.split("|")[0], sector: k.split("|")[1], region: k.split("|")[2], types: k.split("|")[3]
      });
      if (JSON.stringify(now) !== JSON.stringify(orig[k])) {
        fail("Phase 6 skeleton changed for " + k);
      }
    });
    console.log("Phase 6 skeletons byte-identical: 3/3");
  } else {
    console.log("ORIG3 snapshot not found; skipping Phase 6 byte check");
  }

  /* Embedded table deep-equals the canonical JSON. */
  var embeddedSrc = fs.readFileSync(TEMPLATES_JS, "utf8");
  var m = embeddedSrc.match(/var TEMPLATE_TABLE = (\{.*?\});\n  \/\* END/s);
  if (!m) {
    fail("embedded TEMPLATE_TABLE block not found");
  } else {
    var embedded = JSON.parse(m[1]);
    if (JSON.stringify(embedded) !== JSON.stringify(doc.templates)) {
      fail("embedded table differs from data/templates.json");
    } else {
      console.log("embedded table matches data/templates.json");
    }
  }

  /* No timestamps, no em dashes in generated artifacts. */
  [DATA_JSON, TEMPLATES_JS].forEach(function (f) {
    var text = fs.readFileSync(f, "utf8");
    if (/\d{4}-\d{2}-\d{2}T\d{2}:/.test(text)) fail(f + ": contains a timestamp");
    if (/\u2014/.test(text) || /&mdash;/.test(text)) fail(f + ": contains an em dash");
  });

  /* Byte-reproducibility: re-run the generator, hashes must not move. */
  function sha(f) { return crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"); }
  var before = sha(DATA_JSON) + sha(TEMPLATES_JS);
  childProcess.execFileSync("node", [GENERATOR], { stdio: "pipe" });
  var after = sha(DATA_JSON) + sha(TEMPLATES_JS);
  if (before !== after) fail("generator not byte-reproducible");
  else console.log("byte-reproducible: yes");

  if (failures.length) {
    console.log("\nFAILURES (" + failures.length + "):");
    failures.slice(0, 40).forEach(function (f) { console.log(" - " + f); });
    process.exit(1);
  }
  console.log("\nALL CHECKS PASSED");
}

main();
