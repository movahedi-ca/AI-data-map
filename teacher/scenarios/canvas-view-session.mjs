#!/usr/bin/env node
/* scenarios/canvas-view-session.mjs - teacher scenario: view ops across a build.
 *
 * Drives the real Phase 2 canvas (web/canvas/demo.html) through its JS API
 * while recording the frozen 12-action teacher trace. A scripted 6-node
 * recipe (1 collection, 3 systems, 1 thirdparty, 1 destruction, 6 edges) is
 * recorded with Executor+Recorder; after each build item the executor
 * snapshot is translated into a canvas state and pushed through
 * window.DMImport.applyState. Between build steps the scenario interleaves
 * view operations and asserts: (a) "+" zoom leaves node/edge DOM counts
 * unchanged; (b) applyState refits the view (k changes, and deterministically
 * returns to the fit k); (c) getView/setView round-trips through an
 * applyState refit within 1e-9; (d) the "0" key frames the map identically
 * to the refit.
 *
 * Deterministic: fixed recipe, fixed coordinates, as_of 2026-09-15, no clock.
 */

import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const name = "canvas-view-session";
export const domain = "data-mapping/canvas-view-session";
export const recipeId = "p4-canvas-view-session-01";

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
    name: "Canvas view session: 6-node web signup map",
    recipe_id: recipeId,
    schema_version: "1.0.0",
    items: [
      { intent: "add_collection_point", params: { node_id: "n1", x: 60, y: 60, label: "Web signup form" } },
      { intent: "add_node", params: { node_id: "n2", type: "system", x: 180, y: 60, label: "Signup API" } },
      { intent: "add_node", params: { node_id: "n3", type: "system", x: 300, y: 60, label: "User database" } },
      { intent: "add_node", params: { node_id: "n4", type: "system", x: 420, y: 60, label: "Marketing CRM" } },
      { intent: "add_node", params: { node_id: "n5", type: "thirdparty", x: 300, y: 200, label: "Email vendor" } },
      { intent: "add_node", params: { node_id: "n6", type: "destruction", x: 420, y: 200, label: "Purge bin" } },
      { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
      { intent: "connect", params: { a: "n2", b: "n3", cat: "contact" } },
      { intent: "connect", params: { a: "n2", b: "n4", cat: "marketing" } },
      { intent: "connect", params: { a: "n4", b: "n5", cat: "marketing" } },
      { intent: "connect", params: { a: "n3", b: "n6", cat: "contact" } },
      { intent: "connect", params: { a: "n5", b: "n6", cat: "contact" } },
      { intent: "set_field", params: { node_id: "n4", field: "label", value: "CRM platform" } },
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
      { intent: "confirm_node", params: { node_id: "n1" } },
      { intent: "confirm_node", params: { node_id: "n5" } },
      { intent: "run_check", params: { checks: CHECKS.slice() } },
      { intent: "export", params: { format: "xls" } },
    ],
  };
}

/* Translate an executor snapshot into the canvas applyState payload. */
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

async function focusSvg(client) {
  await client.evalRaw("document.getElementById('builder-canvas').focus(); 'focused';");
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
    "JSON.stringify({ hasApi: typeof window.__cvApi === 'object'," +
      " hasApply: !!(window.DMImport && window.DMImport.applyState) })"
  );
  check(api.hasApi && api.hasApply, "canvas api captured (getView/setView/applyState present)");

  const recipe = buildRecipe();
  const { Executor } = await import(pathToFileURL(path.join(libDir, "executor.mjs")).href);
  const { Recorder } = await import(pathToFileURL(path.join(libDir, "recorder.mjs")).href);
  const executor = new Executor(recipe, specsDir);
  const recorder = new Recorder({ executor, shard: name, domain, recipe });

  let lastState = null;
  const syncCanvas = async (record) => {
    lastState = snapshotToState(record.snapshot_after);
    await applyCanvasState(client, lastState);
  };

  // Items 1-6: nodes. After the nodes land, (a) zoom must not touch the DOM.
  for (let i = 0; i < 6; i++) {
    const record = await recorder.rec(recipe.items[i].intent, recipe.items[i].params);
    await syncCanvas(record);
  }
  const c0 = await domCounts(client);
  check(c0.nodes === 6 && c0.edges === 0, "canvas shows 6 nodes, 0 edges after the node build");
  await focusSvg(client);
  await pressKey(client, "+");
  const c1 = await domCounts(client);
  check(
    c1.nodes === c0.nodes && c1.edges === c0.edges,
    "zoom-in (+) left node/edge DOM counts unchanged"
  );

  // Items 7-12: edges. Then the view assertions (b), (c), (d).
  for (let i = 6; i < 12; i++) {
    const record = await recorder.rec(recipe.items[i].intent, recipe.items[i].params);
    await syncCanvas(record);
  }
  const c2 = await domCounts(client);
  check(c2.nodes === 6 && c2.edges === 6, "canvas shows 6 nodes, 6 edges after the edge build");

  // (b) applyState refits the view.
  const vFit = await getView(client);
  await focusSvg(client);
  await pressKey(client, "+");
  await pressKey(client, "+");
  const vZoomed = await getView(client);
  check(vZoomed.k > vFit.k * 1.2, "two '+' presses zoomed in (k " + vFit.k + " -> " + vZoomed.k + ")");
  await applyCanvasState(client, lastState);
  const vRefit = await getView(client);
  check(vRefit.k !== vZoomed.k, "applyState refit changed the zoom k back");
  check(
    Math.abs(vRefit.k - vFit.k) < 1e-9,
    "refit zoom is deterministic (k " + vRefit.k + " == fit k " + vFit.k + ")"
  );

  // (c) getView/setView round-trip across an applyState refit.
  const saved = await getView(client);
  await setView(client, { k: 2.5, tx: 100, ty: -50 });
  const s1 = await getView(client);
  check(
    Math.abs(s1.k - 2.5) < 1e-9 && Math.abs(s1.tx - 100) < 1e-9 && Math.abs(s1.ty + 50) < 1e-9,
    "setView applied the manual zoom {k:2.5, tx:100, ty:-50}"
  );
  await applyCanvasState(client, lastState); // refits, discarding the manual view
  await setView(client, saved);
  const s2 = await getView(client);
  check(
    Math.abs(s2.k - saved.k) < 1e-9 && Math.abs(s2.tx - saved.tx) < 1e-9 && Math.abs(s2.ty - saved.ty) < 1e-9,
    "setView(saved) restored k/tx/ty within 1e-9 after the refit"
  );

  // (d) the "0" key frames the map identically to the refit.
  await focusSvg(client);
  await pressKey(client, "0");
  const vKey = await getView(client);
  check(
    Math.abs(vKey.k - vFit.k) < 1e-9 && Math.abs(vKey.tx - vFit.tx) < 1e-9 && Math.abs(vKey.ty - vFit.ty) < 1e-9,
    "'0' fit matches the applyState refit view within 1e-9"
  );

  // Items 13-18: field, retention, confirms, check, export. Keep the canvas
  // in sync with the label change.
  for (let i = 12; i < recipe.items.length; i++) {
    const item = recipe.items[i];
    const record = await recorder.rec(item.intent, item.params);
    if (item.intent === "set_field") await syncCanvas(record);
  }
  const c3 = await domCounts(client);
  check(c3.nodes === 6 && c3.edges === 6, "final canvas shows 6 nodes, 6 edges");

  const { jsonlPath, manifestPath } = await recorder.writeShard(outDir);
  check(fs.existsSync(jsonlPath), "shard written: " + jsonlPath);

  return {
    name,
    domain,
    nodes: 6,
    edges: 6,
    actions: recipe.items.length,
    records: recorder.records.length,
    shard: name,
    jsonlPath,
    manifestPath,
  };
}
