/* mcp-sessions.test.js - session lifecycle over the stdio JSON-RPC server.
   Run with: node mcp-sessions.test.js
   Extends mcp/test-contract.js (which covers ticket shape, bridge step
   ingest, terminal -> finished, cancel finished -> error, double cancel,
   unknown ids). This file adds: tools/list schema checks, exact result
   key sets (no session-store internals leak), ticket id uniqueness,
   parameter validation (-32602) for get_session/cancel_session, unknown
   tool errors, step events on a ticketed session via the bridge, and the
   cancelled-session contract (get shows cancelled, further cancels are
   clean errors, the server stays healthy). */
"use strict";
var assert = require("assert");
var child_process = require("child_process");
var http = require("http");
var path = require("path");

var REPO = path.resolve(__dirname, "..", "..");
var BRIDGE_PORT = 18993;

var passed = 0;
var failures = 0;
function ok(cond, name, detail) {
  if (cond) {
    passed++;
  } else {
    failures++;
    process.stderr.write("FAIL: " + name + (detail ? " :: " + detail : "") + "\n");
  }
}

function postBridge(pathSuffix, body) {
  return new Promise(function (resolve, reject) {
    var data = JSON.stringify(body);
    var req = http.request(
      { host: "127.0.0.1", port: BRIDGE_PORT, path: pathSuffix, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      function (res) {
        var b = "";
        res.on("data", function (c) { b += c; });
        res.on("end", function () { resolve({ status: res.statusCode, body: JSON.parse(b) }); });
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}

async function main() {
  var child = child_process.spawn(process.execPath, [path.join(REPO, "mcp", "server.js")], {
    env: Object.assign({}, process.env, { AI_DATA_MAP_BRIDGE_PORT: String(BRIDGE_PORT) }),
    stdio: ["pipe", "pipe", "inherit"]
  });

  var pending = new Map();
  var nextId = 1;
  var buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", function (chunk) {
    buf += chunk;
    var idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      var line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      var msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        var r = pending.get(msg.id);
        pending.delete(msg.id);
        r(msg);
      }
    }
  });

  function rpc(method, params) {
    var id = nextId++;
    return new Promise(function (resolve) {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: id, method: method, params: params }) + "\n");
    });
  }
  function callTool(name, args) {
    return rpc("tools/call", { name: name, arguments: args }).then(function (msg) {
      if (msg.error) return { error: msg.error };
      return { value: JSON.parse(msg.result.content[0].text), isError: !!msg.result.isError };
    });
  }
  function ticketFor(recipeId) {
    return callTool("execute_mapping_workflow", {
      recipe: {
        recipe_id: recipeId, schema_version: "1.0.0",
        items: [{ intent: "run_check", params: { checks: ["label_coverage"] } }]
      }
    }).then(function (t) { return t.value; });
  }

  /* ---- tools/list: the three tools with input schemas ---- */
  var list = await rpc("tools/list", {});
  var tools = {};
  (list.result.tools || []).forEach(function (t) { tools[t.name] = t; });
  ok(Object.keys(tools).sort().join(",") === "cancel_session,execute_mapping_workflow,get_session",
    "tools/list exposes exactly the three tools");
  ok(tools.execute_mapping_workflow.inputSchema.required.join(",") === "recipe",
    "execute_mapping_workflow requires recipe");
  ok(tools.get_session.inputSchema.required.join(",") === "session_id",
    "get_session requires session_id");
  ok(tools.cancel_session.inputSchema.required.join(",") === "session_id",
    "cancel_session requires session_id");

  /* ---- unknown tool is a clean -32602, not a crash ---- */
  var unk = await callTool("no_such_tool", {});
  ok(!!unk.error && unk.error.code === -32602 && /Unknown tool/.test(unk.error.message),
    "unknown tool -> clean -32602");

  /* ---- ticket shape, exact keys ---- */
  var t1 = await ticketFor("sess-a-01");
  ok(t1.ok === true && t1.status === "ticketed", "valid recipe mints a ticketed session");
  ok(/^s1-[0-9a-f]{12}$/.test(t1.session_id), "session_id matches ^s1-[0-9a-f]{12}$");
  ok(Object.keys(t1).sort().join(",") === "deep_link,item_count,ok,recipe_id,session_id,status",
    "ticket has exactly the documented keys");
  ok(t1.recipe_id === "sess-a-01" && t1.item_count === 1, "ticket echoes recipe_id and item_count");
  ok(t1.deep_link.indexOf("ticket=" + t1.session_id) !== -1, "deep_link carries the ticket");

  /* ---- session ids are unique per ticket ---- */
  var t2 = await ticketFor("sess-a-02");
  ok(t2.session_id !== t1.session_id, "two tickets get distinct session ids");

  /* ---- get_session: exact record keys, no store internals ---- */
  var g1 = await callTool("get_session", { session_id: t1.session_id });
  ok(g1.value.status === "ticketed", "new session is ticketed");
  ok(Object.keys(g1.value).sort().join(",") === "created_at,item_count,recipe_id,results,session_id,status",
    "get_session returns exactly the documented record keys");
  ok(Array.isArray(g1.value.results) && g1.value.results.length === 0, "new session has no results");
  ok(typeof g1.value.created_at === "string" && !isNaN(Date.parse(g1.value.created_at)),
    "created_at is an ISO timestamp");

  /* ---- bridge step events land in get_session results on a ticketed session ---- */
  await new Promise(function (r) { setTimeout(r, 300); });
  var p1 = await postBridge("/sessions/" + t1.session_id + "/steps",
    { action: "run_check", narration_en: "Checked.", narration_fr: "Verifie.", done_heads: { 0: true }, terminal: false });
  ok(p1.status === 200 && p1.body.ok === true && p1.body.stored === 1, "bridge ingests a step event");
  var g2 = await callTool("get_session", { session_id: t1.session_id });
  ok(g2.value.results.length === 1 && g2.value.results[0].action === "run_check",
    "posted step event appears in get_session results");
  ok(g2.value.status === "ticketed", "non-terminal step keeps the session ticketed");

  /* ---- cancel lifecycle: cancelled sessions refuse further cancels ---- */
  var c1 = await callTool("cancel_session", { session_id: t1.session_id });
  ok(c1.value.status === "cancelled" && c1.value.session_id === t1.session_id,
    "cancel moves a ticketed session to cancelled");
  var g3 = await callTool("get_session", { session_id: t1.session_id });
  ok(g3.value.status === "cancelled", "get_session shows cancelled after cancel");
  ok(g3.value.results.length === 1, "cancelled session keeps its streamed results");
  var c2 = await callTool("cancel_session", { session_id: t1.session_id });
  ok(!!c2.error && c2.error.code === -32002 && /already cancelled/.test(c2.error.message),
    "second cancel is refused with a clean already-cancelled error");
  var c3 = await callTool("cancel_session", { session_id: t1.session_id });
  ok(!!c3.error && /already cancelled/.test(c3.error.message),
    "third cancel is still refused (cancelled sessions refuse further cancels)");

  /* ---- unknown and malformed session ids ---- */
  var gu = await callTool("get_session", { session_id: "s1-000000000000" });
  ok(!!gu.error && gu.error.code === -32002 && /unknown session/.test(gu.error.message),
    "get_session unknown id -> clean error");
  var cu = await callTool("cancel_session", { session_id: "s1-000000000000" });
  ok(!!cu.error && cu.error.code === -32002 && /unknown session/.test(cu.error.message),
    "cancel_session unknown id -> clean error");
  var gm = await callTool("get_session", {});
  ok(!!gm.error && gm.error.code === -32602 && /session_id/.test(gm.error.message),
    "get_session without session_id -> -32602");
  var ge = await callTool("get_session", { session_id: "" });
  ok(!!ge.error && ge.error.code === -32602, "get_session empty session_id -> -32602");
  var gn = await callTool("get_session", { session_id: 42 });
  ok(!!gn.error && gn.error.code === -32602, "get_session non-string session_id -> -32602");
  var cm = await callTool("cancel_session", {});
  ok(!!cm.error && cm.error.code === -32602, "cancel_session without session_id -> -32602");

  /* ---- terminal event finishes a session; finished sessions refuse cancel ---- */
  var t3 = await ticketFor("sess-a-03");
  await postBridge("/sessions/" + t3.session_id + "/steps", { action: "export", terminal: true });
  var g4 = await callTool("get_session", { session_id: t3.session_id });
  ok(g4.value.status === "finished", "terminal step event marks the session finished");
  var c4 = await callTool("cancel_session", { session_id: t3.session_id });
  ok(!!c4.error && /finished/.test(c4.error.message), "cancel on a finished session -> clean error");

  /* ---- the server is still healthy after all of the above ---- */
  var t4 = await ticketFor("sess-a-04");
  ok(t4.ok === true && t4.status === "ticketed", "server still mints tickets after errors and cancels");

  child.kill();
  await new Promise(function (r) { child.on("exit", r); });

  if (failures === 0) {
    console.log("PASS " + passed + " assertions");
  } else {
    console.log("FAIL " + failures + " of " + (passed + failures) + " assertions");
    process.exitCode = 1;
  }
}

var watchdog = setTimeout(function () {
  process.stderr.write("TIMEOUT waiting on the stdio server\n");
  process.exitCode = 1;
  process.exit(1);
}, 60000);

main().then(function () { clearTimeout(watchdog); }).catch(function (e) {
  clearTimeout(watchdog);
  process.stderr.write("HARNESS ERROR: " + (e && e.stack ? e.stack : String(e)) + "\n");
  process.exitCode = 1;
});
