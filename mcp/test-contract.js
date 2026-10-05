#!/usr/bin/env node
"use strict";
/*
 * AI-data-map Phase 7 MCP contract test. Node standard library only.
 * Spawns mcp/server.js over stdio and asserts the Section 2 contract:
 *   valid recipe -> ticket shape
 *   invalid intent -> error contract {ok:false, failed_item_index, reason, partial_state, recovery_hint}
 *   oversize recipe -> rejected with a plain message
 *   determinism -> same recipe validates identically every run
 *   cancel flow -> cancelled; unknown/finished -> clean error
 *   get_session on unknown id -> clean error
 * Also exercises the in-process HTTP bridge: POSTed step events appear in
 * get_session results, and a terminal event marks the session finished.
 * Exit 0 when every assertion passes, 1 otherwise.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const SAMPLE = JSON.parse(fs.readFileSync(path.join(REPO, "specs", "SAMPLE-RECIPE.json"), "utf8"));

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    process.stderr.write(`ok   ${name}\n`);
  } else {
    failures++;
    process.stderr.write(`FAIL ${name}${detail ? " :: " + detail : ""}\n`);
  }
}

function postBridge(port, pathSuffix, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path: pathSuffix, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}

async function main() {
  const BRIDGE_PORT = 18987;
  const child = spawn(process.execPath, [path.join(REPO, "mcp", "server.js")], {
    env: { ...process.env, AI_DATA_MAP_BRIDGE_PORT: String(BRIDGE_PORT) },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const pending = new Map();
  let nextId = 1;
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  function rpc(method, params) {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, { resolve });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  function callTool(name, args) {
    return rpc("tools/call", { name, arguments: args }).then((msg) => {
      if (msg.error) return { error: msg.error };
      const text = msg.result.content[0].text;
      return { value: JSON.parse(text), isError: !!msg.result.isError };
    });
  }

  // 1. initialize + tools/list
  const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  check("initialize returns protocolVersion", !!init.result && typeof init.result.protocolVersion === "string");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await rpc("tools/list", {});
  const names = (list.result.tools || []).map((t) => t.name).sort();
  check("tools/list exposes three tools", JSON.stringify(names) === JSON.stringify(["cancel_session", "execute_mapping_workflow", "get_session"]), names.join(","));

  // 2. valid recipe -> ticket shape
  const t1 = await callTool("execute_mapping_workflow", { recipe: SAMPLE });
  const ticket = t1.value;
  check("valid recipe returns ok ticket", ticket && ticket.ok === true && ticket.status === "ticketed", JSON.stringify(ticket).slice(0, 200));
  check("ticket session_id shape", /^s1-[0-9a-f]{12}$/.test(ticket.session_id), ticket.session_id);
  check("ticket recipe_id echoes", ticket.recipe_id === SAMPLE.recipe_id);
  check("ticket item_count", ticket.item_count === SAMPLE.items.length);
  check("ticket deep_link carries ticket param", typeof ticket.deep_link === "string" && ticket.deep_link.includes("ticket=" + ticket.session_id), ticket.deep_link);

  // 3. invalid intent -> error contract
  const bad = JSON.parse(JSON.stringify(SAMPLE));
  bad.recipe_id = "bad-intent-01";
  bad.items[1] = { intent: "add_nod", params: { node_id: "n2" } };
  const t2 = await callTool("execute_mapping_workflow", { recipe: bad });
  check("invalid intent -> ok:false", t2.value.ok === false);
  check("invalid intent -> failed_item_index 1", t2.value.failed_item_index === 1, String(t2.value.failed_item_index));
  check("invalid intent -> reason names intent", /add_nod/.test(t2.value.reason), t2.value.reason);
  check("invalid intent -> partial_state null", t2.value.partial_state === null);
  check("invalid intent -> recovery_hint present", typeof t2.value.recovery_hint === "string" && t2.value.recovery_hint.length > 0);

  // 3b. recovery intent in recipe -> rejected
  const rec = JSON.parse(JSON.stringify(SAMPLE));
  rec.recipe_id = "recovery-in-recipe-01";
  rec.items.push({ intent: "abort_session", params: { reason: "nope" } });
  const t2b = await callTool("execute_mapping_workflow", { recipe: rec });
  check("recovery intent in recipe -> rejected", t2b.value.ok === false && /executor-only/.test(t2b.value.reason), t2b.value.reason);

  // 4. oversize: too many items
  const many = { recipe_id: "too-many-01", schema_version: "1.0.0", items: [] };
  for (let i = 0; i < 201; i++) many.items.push({ intent: "run_check", params: { checks: ["label_coverage"] } });
  const t3 = await callTool("execute_mapping_workflow", { recipe: many });
  check("201 items -> rejected", t3.value.ok === false && /201 items/.test(t3.value.reason) && /200/.test(t3.value.reason), t3.value.reason);

  // 4b. oversize: >64KB JSON (each item stays under the per-item params limit)
  const big = { recipe_id: "too-big-01", schema_version: "1.0.0", items: [] };
  for (let i = 0; i < 120; i++) {
    big.items.push({
      intent: "set_retention",
      params: {
        node_id: "n1",
        record_type: "Records " + "x".repeat(110),
        range_min_years: 6,
        range_max_years: 7,
        statute: "Loi sur l'administration fiscale, RLRQ, c. A-6.002, ss. 34, 35.3 " + "y".repeat(200),
        as_of: "2026-10-04",
        anchor: "after closure " + "z".repeat(100),
      },
    });
  }
  const t3b = await callTool("execute_mapping_workflow", { recipe: big });
  check(">64KB recipe -> rejected", t3b.value.ok === false && /64KB/.test(t3b.value.reason), String(t3b.value.reason).slice(0, 160));

  // 5. determinism: same invalid recipe validates identically twice
  const t4a = await callTool("execute_mapping_workflow", { recipe: bad });
  const t4b = await callTool("execute_mapping_workflow", { recipe: bad });
  check("deterministic validation", t4a.value.failed_item_index === t4b.value.failed_item_index && t4a.value.reason === t4b.value.reason);

  // 6. get_session on ticket -> ticketed, empty results
  const g1 = await callTool("get_session", { session_id: ticket.session_id });
  check("get_session returns ticketed session", g1.value.session_id === ticket.session_id && g1.value.status === "ticketed" && Array.isArray(g1.value.results) && g1.value.results.length === 0);

  // 7. bridge: POST step event -> appears in get_session results
  await new Promise((r) => setTimeout(r, 300)); // let the bridge bind
  const p1 = await postBridge(BRIDGE_PORT, `/sessions/${ticket.session_id}/steps`, {
    action: "add_collection_point", narration_en: "Added the intake form.", narration_fr: "Formulaire ajoute.", done_heads: { 0: true }, terminal: false,
  });
  check("bridge POST step -> 200", p1.status === 200 && p1.body.ok === true && p1.body.stored === 1, JSON.stringify(p1.body));
  const g2 = await callTool("get_session", { session_id: ticket.session_id });
  check("posted step event in get_session results", g2.value.results.length === 1 && g2.value.results[0].action === "add_collection_point", JSON.stringify(g2.value.results).slice(0, 160));

  // 8. terminal step event -> session finished
  await postBridge(BRIDGE_PORT, `/sessions/${ticket.session_id}/steps`, { action: "export", narration_en: "Exported.", narration_fr: "Exporte.", done_heads: {}, terminal: true });
  const g3 = await callTool("get_session", { session_id: ticket.session_id });
  check("terminal event marks session finished", g3.value.status === "finished" && g3.value.results.length === 2);

  // 9. cancel flow: finished session -> clean error
  const c1 = await callTool("cancel_session", { session_id: ticket.session_id });
  check("cancel finished session -> clean error", !!c1.error && /finished/.test(c1.error.message), JSON.stringify(c1.error));

  // fresh ticket for the cancel path
  const t5 = await callTool("execute_mapping_workflow", { recipe: SAMPLE });
  const c2 = await callTool("cancel_session", { session_id: t5.value.session_id });
  check("cancel ticketed session -> cancelled", c2.value.session_id === t5.value.session_id && c2.value.status === "cancelled");
  const c3 = await callTool("cancel_session", { session_id: t5.value.session_id });
  check("cancel again -> clean error", !!c3.error && /already cancelled/.test(c3.error.message));

  // 10. unknown ids -> clean errors
  const g4 = await callTool("get_session", { session_id: "s1-deadbeefcafe" });
  check("get_session unknown -> clean error", !!g4.error && /unknown session/.test(g4.error.message));
  const c4 = await callTool("cancel_session", { session_id: "s1-deadbeefcafe" });
  check("cancel unknown -> clean error", !!c4.error && /unknown session/.test(c4.error.message));

  // 11. schema_version and recipe_id validation
  const sv = await callTool("execute_mapping_workflow", { recipe: { recipe_id: "x", schema_version: "2.0.0", items: [] } });
  check("bad schema_version -> rejected", sv.value.ok === false && sv.value.failed_item_index === null && /2\.0\.0/.test(sv.value.reason));
  const rid = await callTool("execute_mapping_workflow", { recipe: { recipe_id: "bad id!", schema_version: "1.0.0", items: [{ intent: "export", params: { format: "xls" } }] } });
  check("bad recipe_id -> rejected", rid.value.ok === false && rid.value.failed_item_index === null);

  child.kill();
  await new Promise((r) => child.on("exit", r));
  process.stderr.write(failures === 0 ? "\nALL GREEN\n" : `\n${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write("HARNESS ERROR: " + (e && e.stack ? e.stack : String(e)) + "\n");
  process.exit(1);
});
