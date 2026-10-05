#!/usr/bin/env node
/* scenarios/canvas-keyboard-build.mjs - teacher scenario: keyboard-only view build.
 *
 * Drives the real Phase 2 canvas (web/canvas/demo.html) through its JS API
 * while recording the frozen 12-action teacher trace. A scripted 5-node
 * recipe (1 collection, 2 systems, 1 thirdparty, 1 destruction, 4 edges)
 * is recorded with Executor+Recorder; the executor snapshots are pushed
 * through window.DMImport.applyState. The browser-side work is keyboard
 * only: Tab to the svg, arrow keys pan, "+" zooms, "0" fits, Tab walks into
 * nodes, Enter toggles selection. Assertions check the view transform and
 * focus/selection state after each key.
 *
 * Deterministic: fixed recipe, fixed coordinates, as_of 2026-09-15, no clock.
 */

import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const name = "canvas-keyboard-build";
export const domain = "data-mapping/canvas-keyboard-build";
export const recipeId = "p4-canvas-keyboard-build-01";

const AS_OF = "2026-09-15";
const RETENTION = {
  record_type: "Quebec tax books and records",
  range_min_years: 6,
  range_max_years: 7,
  statute: "Loi sur l'administration fiscale, RLRQ, c. A-6.002, ss. 34, 35.3",
};
const CHECKS = ["label_coverage", "connectivity", "retention_cited", "edge_categories"];
const NODE_IDS = ["n1", "n2", "n3", "n4", "n5"];

function check(cond, msg) {
  if (!cond) throw new Error("scenario assertion failed: " + msg);
  console.log("  ok - " + msg);
}

function buildRecipe() {
  return {
    name: "Canvas keyboard build: 5-node support ticket map",
    recipe_id: recipeId,
    schema_version: "1.0.0",
    items: [
      { intent: "add_collection_point", params: { node_id: "n1", x: 60, y: 60, label: "Support ticket form" } },
      { intent: "add_node", params: { node_id: "n2", type: "system", x: 180, y: 60, label: "Ticket queue" } },
      { intent: "add_node", params: { node_id: "n3", type: "system", x: 300, y: 60, label: "Knowledge base" } },
      { intent: "add_node", params: { node_id: "n4", type: "thirdparty", x: 420, y: 60, label: "Chat vendor" } },
      { intent: "add_node", params: { node_id: "n5", type: "destruction", x: 300, y: 200, label: "Archive purge" } },
      { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
      { intent: "connect", params: { a: "n2", b: "n3", cat: "contact" } },
      { intent: "connect", params: { a: "n2", b: "n4", cat: "marketing" } },
      { intent: "connect", params: { a: "n3", b: "n5", cat: "contact" } },
      { intent: "set_field", params: { node_id: "n4", field: "label", value: "Chat support vendor" } },
      { intent: "set_field", params: { node_id: "n2", field: "x", value: 200 } },
      {
        intent: "set_retention",
        params: {
          node_id: "n2",
          record_type: RETENTION.record_type,
          range_min_years: RETENTION.range_min_years,
          range_max_years: RETENTION.range_max_years,
          statute: RETENTION.statute,
          as_of: AS_OF,
        },
      },
      { intent: "confirm_node", params: { node_id: "n1" } },
      { intent: "confirm_node", params: { node_id: "n4" } },
      { intent: "run_check", params: { checks: CHECKS.slice() } },
      { intent: "export", params: { format: "xls" } },
    ],
  };
}

/* The node-only starting state, derived from the fixed recipe literals. */
function initialState() {
  const nodes = {};
  for (const item of buildRecipe().items) {
    if (item.intent === "add_collection_point") {
      nodes[item.params.node_id] = { type: "collection", x: item.params.x, y: item.params.y, label: item.params.label };
    } else if (item.intent === "add_node") {
      nodes[item.params.node_id] = { type: item.params.type, x: item.params.x, y: item.params.y, label: item.params.label };
    }
  }
  return { nodes, edges: [] };
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

async function domCounts(client) {
  return client.evalJson(
    "JSON.stringify({ nodes: document.querySelectorAll('#dm-viewport .node').length," +
      " edges: document.querySelectorAll('#dm-viewport .edge').length })"
  );
}

async function activeInfo(client) {
  return client.evalJson(
    "JSON.stringify({ id: document.activeElement ? document.activeElement.id : null," +
      " node: document.activeElement ? document.activeElement.getAttribute('data-node') : null })"
  );
}

async function selectedCount(client) {
  return client.evalJson(
    "JSON.stringify({ n: document.querySelectorAll('#dm-viewport .node.selected').length })"
  );
}

async function pressKey(client, key) {
  await client.callTool("press_key", { key });
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

  // The 5 nodes land on the canvas first; the rest of the scenario is
  // keyboard only.
  await applyCanvasState(client, initialState());
  const c0 = await domCounts(client);
  check(c0.nodes === 5 && c0.edges === 0, "canvas shows the 5 recipe nodes");

  // Tab from the body to the svg.
  await client.evalRaw("document.body.focus(); 'body';");
  let tabbed = 0;
  let ae = await activeInfo(client);
  while (ae.id !== "builder-canvas" && tabbed < 12) {
    await pressKey(client, "Tab");
    tabbed += 1;
    ae = await activeInfo(client);
  }
  check(ae.id === "builder-canvas", "Tab reached the canvas svg after " + tabbed + " presses");

  // Arrow keys pan.
  const v0 = await getView(client);
  await pressKey(client, "ArrowLeft");
  const v1 = await getView(client);
  check(v1.tx - v0.tx === 40, "ArrowLeft panned the view by 40 (tx " + v0.tx + " -> " + v1.tx + ")");

  // "+" zooms.
  await pressKey(client, "+");
  const v2 = await getView(client);
  check(v2.k > v1.k, "'+' zoomed in (k " + v1.k + " -> " + v2.k + ")");
  check(
    Math.abs(v2.k - v1.k * 1.25) < 1e-9,
    "'+' multiplied k by the 1.25 zoom step"
  );

  // "0" fits the map; it must match the deterministic refit exactly.
  await pressKey(client, "0");
  const vKey = await getView(client);
  await applyCanvasState(client, initialState());
  const vRefit = await getView(client);
  check(
    Math.abs(vKey.k - vRefit.k) < 1e-9 && Math.abs(vKey.tx - vRefit.tx) < 1e-9 && Math.abs(vKey.ty - vRefit.ty) < 1e-9,
    "'0' fit matches the applyState refit within 1e-9"
  );

  // Tab walks from the svg into the first node.
  await client.evalRaw("document.getElementById('builder-canvas').focus(); 'focused';");
  await pressKey(client, "Tab");
  const ae2 = await activeInfo(client);
  check(
    ae2.node !== null && NODE_IDS.indexOf(ae2.node) !== -1,
    "Tab from the svg focused a recipe node (data-node=" + ae2.node + ")"
  );

  // Enter toggles selection on the focused node.
  const s0 = await selectedCount(client);
  await pressKey(client, "Enter");
  const s1 = await selectedCount(client);
  check(s1.n === s0.n + 1, "Enter selected the focused node (" + s0.n + " -> " + s1.n + ")");
  await pressKey(client, "Enter");
  const s2 = await selectedCount(client);
  check(s2.n === s0.n, "Enter again deselected it (" + s1.n + " -> " + s2.n + ")");

  // Record the scripted trace, keeping the canvas in sync with the build.
  const recipe = buildRecipe();
  const { Executor } = await import(pathToFileURL(path.join(libDir, "executor.mjs")).href);
  const { Recorder } = await import(pathToFileURL(path.join(libDir, "recorder.mjs")).href);
  const executor = new Executor(recipe, specsDir);
  const recorder = new Recorder({ executor, shard: name, domain, recipe });
  for (const item of recipe.items) {
    const record = await recorder.rec(item.intent, item.params);
    if (item.intent === "add_collection_point" || item.intent === "add_node" ||
        item.intent === "connect" || item.intent === "set_field") {
      await applyCanvasState(client, snapshotToState(record.snapshot_after));
    }
  }
  const cFinal = await domCounts(client);
  check(cFinal.nodes === 5 && cFinal.edges === 4, "final canvas counts equal the recipe (5 nodes, 4 edges)");

  const { jsonlPath, manifestPath } = await recorder.writeShard(outDir);
  check(fs.existsSync(jsonlPath), "shard written: " + jsonlPath);

  return {
    name,
    domain,
    nodes: 5,
    edges: 4,
    actions: recipe.items.length,
    records: recorder.records.length,
    shard: name,
    jsonlPath,
    manifestPath,
  };
}
