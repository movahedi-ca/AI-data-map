/* mcp-openapi.test.js - openapi.yaml documents what the code implements.
   Run with: node mcp-openapi.test.js
   Text-level drift checks between mcp/openapi.yaml, mcp/server.js and
   mcp/http-bridge.js (no YAML parser available; plain node only).
   Complements mcp/test-contract.js, which does not inspect the spec. */
"use strict";
var assert = require("assert");
var fs = require("fs");
var path = require("path");

var MCP = path.resolve(__dirname, "..", "..", "mcp");
var yaml = fs.readFileSync(path.join(MCP, "openapi.yaml"), "utf8");
var server = fs.readFileSync(path.join(MCP, "server.js"), "utf8");
var bridge = fs.readFileSync(path.join(MCP, "http-bridge.js"), "utf8");

var passed = 0;
var failures = 0;
function ok(cond, name) {
  if (cond) {
    passed++;
  } else {
    failures++;
    process.stderr.write("FAIL: " + name + "\n");
  }
}

/* ---- the three HTTP paths exist in both the spec and the bridge ---- */
ok(yaml.indexOf("/sessions/{sessionId}/steps:") !== -1, "spec documents POST /sessions/{sessionId}/steps");
ok(yaml.indexOf("/sessions/{sessionId}:") !== -1, "spec documents GET /sessions/{sessionId}");
ok(yaml.indexOf("/sessions/{sessionId}/stream:") !== -1, "spec documents GET /sessions/{sessionId}/stream");
ok(bridge.indexOf("/\\/sessions\\/([^/]+)(\\/steps|\\/stream)?$/") !== -1 ||
   bridge.indexOf("sessions") !== -1, "bridge implements the /sessions/:id routes");
ok(/\(\/steps|\/stream\)\?/.test(bridge), "bridge route covers the /steps and /stream suffixes");

/* ---- ToolInput intent enum is exactly the 9 authoring intents ---- */
var enums = [];
var re = /enum: \[([^\]]+)\]/g;
var m;
while ((m = re.exec(yaml)) !== null) { enums.push(m[1]); }
var intentEnum = null;
enums.forEach(function (e) { if (e.indexOf("add_node") !== -1) intentEnum = e; });
ok(intentEnum !== null, "spec has an intent enum listing add_node");
var listed = intentEnum.split(",").map(function (s) { return s.trim(); }).sort();
var authoring = ["add_node", "add_collection_point", "connect", "set_field",
  "set_retention", "run_check", "export", "confirm_node", "flag_for_review"].sort();
ok(JSON.stringify(listed) === JSON.stringify(authoring), "intent enum is exactly the 9 authoring intents");
["undo_last", "skip_recipe_item", "abort_session"].forEach(function (ri) {
  ok(intentEnum.indexOf(ri) === -1, "intent enum excludes recovery intent " + ri);
});
ok(yaml.indexOf("undo_last") !== -1 && yaml.toLowerCase().indexOf("executor-only recovery") !== -1,
  "spec notes recovery intents are rejected in recipes");

/* ---- SessionTicket matches the server's ticket object ---- */
ok(yaml.indexOf("required: [ok, session_id, recipe_id, item_count, status, deep_link]") !== -1,
  "SessionTicket requires the six ticket fields");
["session_id: session.session_id", "recipe_id: session.recipe_id", "item_count: session.item_count",
 'status: "ticketed"', "deep_link:"].forEach(function (frag) {
  ok(server.indexOf(frag) !== -1, "server ticket object sets " + frag.split(":")[0]);
});
ok(/status: \{ type: string, const: ticketed \}/.test(yaml), "SessionTicket status is const ticketed");

/* ---- ValidationError matches errorContract ---- */
ok(yaml.indexOf("required: [ok, failed_item_index, reason, partial_state, recovery_hint]") !== -1,
  "ValidationError requires the five error-contract fields");
ok(server.indexOf("function errorContract(failed_item_index, reason)") !== -1,
  "server defines errorContract(failed_item_index, reason)");
ok(server.indexOf("partial_state: null") !== -1, "errorContract sets partial_state null");
ok(server.indexOf("recovery_hint:") !== -1, "errorContract sets recovery_hint");

/* ---- versions and limits agree ---- */
var toolVersion = (server.match(/const TOOL_VERSION = "([^"]+)"/) || [])[1];
var specVersion = (yaml.match(/\n  version: ([0-9.]+)/) || [])[1];
ok(toolVersion === "1.0.0", "server TOOL_VERSION is 1.0.0");
ok(specVersion === toolVersion, "spec info.version matches server TOOL_VERSION");
var maxItems = (server.match(/const MAX_ITEMS = (\d+)/) || [])[1];
ok(yaml.indexOf("maxItems: " + maxItems) !== -1, "spec maxItems matches server MAX_ITEMS (" + maxItems + ")");
var maxParams = (server.match(/const MAX_PARAMS_BYTES = (\d+)/) || [])[1];
ok(yaml.indexOf(maxParams) !== -1, "spec mentions the per-item params byte limit (" + maxParams + ")");
var maxJson = (server.match(/const MAX_JSON_BYTES = (\d+) \* 1024/) || [])[1];
ok(maxJson === "64", "server enforces a 64KB total recipe limit");
ok(yaml.indexOf("64KB") === -1, "DRIFT: the 64KB total recipe limit is not documented in the spec");

/* ---- StepEvent and SessionRecord match the bridge ---- */
ok(yaml.indexOf("required: [action]") !== -1, "StepEvent requires action");
ok(bridge.indexOf("validStepEvent") !== -1 && bridge.indexOf('"action" must be a non-empty string') !== -1,
  "bridge validates that action is a non-empty string");
["ticketed", "running", "finished", "cancelled"].forEach(function (st) {
  ok(yaml.indexOf(st) !== -1, "SessionRecord status enum includes " + st);
});
ok(bridge.indexOf('status: "running"') !== -1, "bridge lazy sessions start as running");
ok(server.indexOf('status: "ticketed"') !== -1, "server mints sessions as ticketed");

/* ---- networking surface: localhost only, default port agrees ---- */
ok(yaml.indexOf("http://127.0.0.1:8787") !== -1, "spec servers URL is 127.0.0.1:8787");
ok(bridge.indexOf("AI_DATA_MAP_BRIDGE_PORT || 8787") !== -1, "bridge default port is 8787");
ok(bridge.indexOf('"127.0.0.1"') !== -1, "bridge binds 127.0.0.1");

/* ---- PlainError matches the bridge error body ---- */
ok(yaml.indexOf("required: [ok, error]") !== -1, "PlainError requires ok and error");
ok(bridge.indexOf("{ ok: false, error:") !== -1, "bridge error bodies are {ok:false, error}");

/* ---- deep_link contract ---- */
ok(server.indexOf("https://movahedi.ca/tools/data-mapping-guide/") !== -1,
  "server deep_link base is the guide page");
ok(yaml.indexOf("?ticket=") !== -1, "spec documents the ?ticket= deep link parameter");

/* ---- no em dashes in the spec (it claims none) ---- */
ok(yaml.indexOf("\u2014") === -1 && yaml.indexOf("\u2013") === -1, "spec contains no em/en dashes");

/* ---- documented drift: the stdio tools get_session and cancel_session
        have no component schemas; only execute_mapping_workflow's input is
        described (ToolInput). Recorded here so a fix trips this test. ---- */
ok(yaml.indexOf("get_session") === -1, "DRIFT: get_session stdio tool has no spec schema");
ok(yaml.indexOf("cancel_session") === -1, "DRIFT: cancel_session stdio tool has no spec schema");

if (failures === 0) {
  console.log("PASS " + passed + " assertions");
} else {
  console.log("FAIL " + failures + " of " + (passed + failures) + " assertions");
  process.exitCode = 1;
}
