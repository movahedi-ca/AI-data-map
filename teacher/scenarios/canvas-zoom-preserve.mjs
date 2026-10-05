#!/usr/bin/env node
/* scenarios/canvas-zoom-preserve.mjs - teacher scenario: view survives refits.
 *
 * Drives the real Phase 2 canvas (web/canvas/demo.html) through its JS API
 * while recording the frozen 12-action teacher trace. The chain note holds:
 * applyState always refits, so a manually set view is preserved across
 * applyState calls with the getView/setView pair: applyState(stateA), zoom
 * via setView, save v1, applyState(stateB) (assert the refit moved k away
 * from v1.k), setView(v1) (assert k/tx/ty restored within 1e-9),
 * applyState(stateC). Then the toolbar fullscreen button #cv-full is
 * toggled and its label flip asserted (headless takes the pseudo-fullscreen
 * path, accepted either way). A scripted 6-node, 5-edge recipe is recorded
 * with Executor+Recorder; executor snapshots are pushed through
 * window.DMImport.applyState.
 *
 * Deterministic: fixed recipe, fixed coordinates, as_of 2026-09-15, no clock.
 */

import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const name = "canvas-zoom-preserve";
export const domain = "data-mapping/canvas-zoom-preserve";
export const recipeId = "p4-canvas-zoom-preserve-01";

const AS_OF = "2026-09-15";
const RETENTION = {
  record_type: "Quebec tax books and records",
  range_min_years: 6,
  range_max_years: 7,
  statute: "Loi sur l'administration fiscale, RLRQ, c. A-6.002, ss. 34, 35.3",
};
const CHECKS = ["label_coverage", "connectivity", "retention_cited", "edge_categories"];

function check(cond, msg) {
  if (!cond) throw new Error("scenario assertion failed: " + msg);
  console.log("  ok - " + msg);
}

function buildRecipe() {
  return {
    name: "Canvas zoom preserve: 6-node newsletter map",
    recipe_id: recipeId,
    schema_version: "1.0.0",
    items: [
      { intent: "add_collection_point", params: { node_id: "n1", x: 60, y: 60, label: "Newsletter signup" } },
      { intent: "add_node", params: { node_id: "n2", type: "system", x: 180, y: 60, label: "Signup API" } },
      { intent: "add_node", params: { node_id: "n3", type: "system", x: 300, y: 60, label: "Subscriber list" } },
      { intent: "add_node", params: { node_id: "n4", type: "system", x: 420, y: 60, label: "Campaign tool" } },
      { intent: "add_node", params: { node_id: "n5", type: "thirdparty", x: 300, y: 200, label: "Send vendor" } },
      { intent: "add_node", params: { node_id: "n6", type: "destruction", x: 420, y: 200, label: "Purge bin" } },
      { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
      { intent: "connect", params: { a: "n2", b: "n3", cat: "contact" } },
      { intent: "connect", params: { a: "n2", b: "n4", cat: "marketing" } },
      { intent: "connect", params: { a: "n4", b: "n5", cat: "marketing" } },
      { intent: "connect", params: { a: "n5", b: "n6", cat: "contact" } },
      {
        intent: "set_retention",
        params: {
          node_id: "n3",
          record_type: RETENTION.record_type,
          range_min_years: RETENTION.range_min_years,
          range_max_years: RETENTION.range_max_years,
          statute: RETENTION.statute,
          as_of: AS_OF,
        },
      },
      { intent: "run_check", params: { checks: CHECKS.slice() } },
      { intent: "export", params: { format: "xls" } },
    ],
  };
}

function snapshotToState(snapshot) {
  const c = snapshot.canvas;
  const nodes = {};
  for (const id of Object.keys(c.nodes)) {
    nodes[id] = { type: c.nodes[id].type, x: c.nodes[id].x, y: c.nodes[id].y, label: c.nodes[id].label };
  }
  return { nodes, edges: c.edges.map((e) => ({ a: e.a, b: e.b, cat: e.cat })) };
}

async function applyCanvasState(client, state) {
  const res = await client.evalRaw(
    "window.__cvApi.applyState(" + JSON.stringify(state) + "); 'applied';"
  );
  if (res.indexOf("applied") === -1) throw new Error("applyState call failed: " + res);
}

async function getView(client) {
  return client.evalJson("JSON.stringify(window.__cvApi.getView())");
}

async function setView(client, v) {
  await client.evalRaw("window.__cvApi.setView(" + JSON.stringify(v) + "); 'set';");
}

async function domCounts(client) {
  return client.evalJson(
    "JSON.stringify({ nodes: document.querySelectorAll('#dm-viewport .node').length," +
      " edges: document.querySelectorAll('#dm-viewport .edge').length })"
  );
}

async function fullLabel(client) {
  return client.evalJson("JSON.stringify(document.getElementById('cv-full').textContent)");
}

/* Native fullscreen exit resolves asynchronously (fullscreenchange fires
 * after exitFullscreen returns), so the second flip is polled. */
async function waitFullLabel(client, expected) {
  for (let i = 0; i < 40; i++) {
    if ((await fullLabel(client)) === expected) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("scenario assertion failed: fullscreen label never became '" + expected + "'");
}

function closeEnough(a, b, eps) {
  return Math.abs(a - b) < eps;
}

export async function run(ctx) {
  const { client, base, specsDir, libDir, outDir } = ctx;
  console.log("[" + name + "] navigate " + base + "/canvas/demo.html");
  await client.callTool("navigate", { url: base + "/canvas/demo.html" });
  await client.callTool("wait_for", { target: "#builder-canvas", timeout: 15000 });
  const api = await client.evalJson(
    "JSON.stringify({ hasApi: typeof window.__cvApi === 'object' })"
  );
  check(api.hasApi, "canvas api captured (getView/setView present)");

  // Record the scripted trace first; the snapshots give us the three
  // states for the view-preservation script.
  const recipe = buildRecipe();
  const { Executor } = await import(pathToFileURL(path.join(libDir, "executor.mjs")).href);
  const { Recorder } = await import(pathToFileURL(path.join(libDir, "recorder.mjs")).href);
  const executor = new Executor(recipe, specsDir);
  const recorder = new Recorder({ executor, shard: name, domain, recipe });
  const states = [];
  for (const item of recipe.items) {
    const record = await recorder.rec(item.intent, item.params);
    if (item.intent === "add_collection_point" || item.intent === "add_node" || item.intent === "connect") {
      states.push(snapshotToState(record.snapshot_after));
    }
  }
  check(states.length === 11, "captured 11 build snapshots (6 nodes + 5 edges)");
  const stateA = states[9];   // 6 nodes, 4 edges
  const stateB = states[10];  // 6 nodes, 5 edges
  const stateC = states[10];  // final map state
  check(stateA.edges.length === 4, "stateA carries 4 edges");
  check(stateB.edges.length === 5, "stateB carries 5 edges");

  // The chain: applyState always refits, so getView/setView brackets it.
  await applyCanvasState(client, stateA);
  await setView(client, { k: 2.0, tx: 50, ty: -30 });
  const v1 = await getView(client);
  check(
    closeEnough(v1.k, 2.0, 1e-9) && closeEnough(v1.tx, 50, 1e-9) && closeEnough(v1.ty, -30, 1e-9),
    "setView zoomed to {k:2.0, tx:50, ty:-30} (v1 saved)"
  );
  await applyCanvasState(client, stateB);
  const vB = await getView(client);
  check(vB.k !== v1.k, "applyState(stateB) refit moved k away from v1.k (" + v1.k + " -> " + vB.k + ")");
  await setView(client, v1);
  const v2 = await getView(client);
  check(
    closeEnough(v2.k, v1.k, 1e-9) && closeEnough(v2.tx, v1.tx, 1e-9) && closeEnough(v2.ty, v1.ty, 1e-9),
    "setView(v1) restored k/tx/ty within 1e-9 after the refit"
  );
  await applyCanvasState(client, stateC);

  // Fullscreen toggle via the toolbar button.
  const l0 = await fullLabel(client);
  check(l0 === "Fullscreen", "fullscreen button starts labelled 'Fullscreen'");
  await client.callTool("click", { selector: "#cv-full" });
  await waitFullLabel(client, "Exit fullscreen");
  check(true, "fullscreen button flipped to 'Exit fullscreen' after toggle");
  await client.callTool("click", { selector: "#cv-full" });
  await waitFullLabel(client, "Fullscreen");
  check(true, "fullscreen button flipped back to 'Fullscreen' after second toggle");

  const cFinal = await domCounts(client);
  check(cFinal.nodes === 6 && cFinal.edges === 5, "final canvas counts equal the recipe (6 nodes, 5 edges)");

  const { jsonlPath, manifestPath } = await recorder.writeShard(outDir);
  check(fs.existsSync(jsonlPath), "shard written: " + jsonlPath);

  return {
    name,
    domain,
    nodes: 6,
    edges: 5,
    actions: recipe.items.length,
    records: recorder.records.length,
    shard: name,
    jsonlPath,
    manifestPath,
  };
}
