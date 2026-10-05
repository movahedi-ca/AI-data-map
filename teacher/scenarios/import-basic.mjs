#!/usr/bin/env node
/* scenarios/import-basic.mjs - pilot teacher scenario: real template in, recipe out.
 *
 * Drives the served Phase 1 demo in a real browser: uploads the real
 * Data-Inventory-Template.xlsx, picks the EXAMPLE 2 (SaaS startup) split
 * sections, accepts the prefilled column mapping, reviews, builds. The built
 * map is captured from window.DMImport.applyState and turned into a recipe:
 * one add_collection_point/add_node per node in ascending id order, one
 * connect per edge, then set_retention, run_check (all four checks), export.
 * The export action is recorded only after the page's own Excel download
 * fires in the browser. The Executor+Recorder replays exactly that action
 * sequence; the shard is written to outDir as pilot-import-basic.
 *
 * Deterministic: the same template file in, the same recipe out. Fixed
 * citation date, observed coordinates, no clock or random input.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  acceptGate,
  waitStep,
  uploadFile,
  installApplyHook,
  readAppliedState,
  pickSheets,
  mappingGuesses,
  reviewState,
  confirmExportDownload,
} from "./common.mjs";

export const name = "import-basic";
export const domain = "data-mapping";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
// Fixed citation check date for the retention annotation. Never "today".
const AS_OF = "2026-09-15";
const RETENTION = {
  record_type: "Quebec tax books and records",
  range_min_years: 6,
  range_max_years: 7,
  statute: "Loi sur l'administration fiscale, RLRQ, c. A-6.002, ss. 34, 35.3",
};
const CHECKS = ["label_coverage", "connectivity", "retention_cited", "edge_categories"];
const NODE_TYPES = ["collection", "system", "thirdparty", "destruction"];
const EDGE_CATS = ["contact", "payment", "marketing"];

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function check(cond, msg) {
  if (!cond) throw new Error("scenario assertion failed: " + msg);
  console.log("  ok - " + msg);
}

function nodeNum(id) {
  return parseInt(id.slice(1), 10);
}

export async function run(ctx) {
  const { client, base, specsDir, libDir, outDir, templatePath } = ctx;
  console.log("[" + name + "] navigate " + base + "/index.html");
  await client.callTool("navigate", { url: base + "/index.html" });
  await acceptGate(client);
  await installApplyHook(client);

  const bytes = fs.readFileSync(templatePath);
  console.log("[" + name + "] upload " + templatePath + " (" + bytes.length + " bytes)");
  await uploadFile(client, "Data-Inventory-Template.xlsx", XLSX_MIME, bytes);

  await waitStep(client, "imp-step-sheets");
  const picked = await pickSheets(client, "EXAMPLE 2", "EXAMPLE 2");
  console.log("[" + name + "] sheets: " + picked.sysText + " / " + picked.flowsText);

  await client.callTool("click", { selector: "#imp-sheets-next" });
  await waitStep(client, "imp-step-map");
  const guesses = await mappingGuesses(client);
  check(guesses.length === 17, "mapping step shows 17 prefilled column guesses");
  check(
    guesses.every((g) => g.value !== ""),
    "every column guess is prefilled (accepted as-is)"
  );

  await client.callTool("click", { selector: "#imp-map-next" });
  await waitStep(client, "imp-step-review");
  const rev = await reviewState(client);
  check(rev.sysRows.length === 7, "review lists 7 systems");
  check(rev.flowRows.length === 5, "review lists 5 flows");
  const cats = rev.flowRows.map((f) => f.cat);
  check(
    JSON.stringify(cats) === JSON.stringify(["contact", "payment", "marketing", "contact", "contact"]),
    "flow categories proposed contact/payment/marketing/contact/contact"
  );
  check(
    rev.flowRows.every((f) => f.badge === "Suggested"),
    "every category proposal badged Suggested, nothing silent"
  );
  check(rev.buildDisabled === false, "build enabled with all categories proposed");

  await client.callTool("click", { selector: "#imp-build" });
  await waitStep(client, "imp-step-done");
  const state = await readAppliedState(client);
  check(state && state.nodes && Array.isArray(state.edges), "captured the applyState payload");
  const status = await client.evalJson(
    "JSON.stringify({ status: document.getElementById('builder-status').textContent })"
  );
  check(status.status.indexOf("Imported map") !== -1, "canvas status confirms the import");

  // Build the recipe from the observed map. Node ids ascend n1..nK with no
  // gaps; coordinates are the observed ones, clamped to the frozen box.
  const observed = Object.entries(state.nodes)
    .map(([id, n]) => ({ id, type: n.type, label: n.label, x: n.x, y: n.y }))
    .sort((a, b) => nodeNum(a.id) - nodeNum(b.id));
  const K = observed.length;
  check(K > 0, "observed map has at least one node");
  observed.forEach((n, i) => {
    check(n.id === "n" + (i + 1), "node ids ascend n1..n" + K + " with no gaps");
    check(NODE_TYPES.indexOf(n.type) !== -1, "node " + n.id + " has a known type");
    check(
      typeof n.label === "string" && n.label.length >= 1 && n.label.length <= 200,
      "node " + n.id + " has a usable label"
    );
  });

  const recipe = {
    name: "Pilot import: SaaS template EXAMPLE 2 to canvas map",
    recipe_id: "pilot-import-basic-01",
    schema_version: "1.0.0",
    items: [],
  };
  for (const n of observed) {
    const x = clamp(Math.round(n.x), 40, 600);
    const y = clamp(Math.round(n.y), 40, 380);
    if (n.type === "collection") {
      recipe.items.push({
        intent: "add_collection_point",
        params: { node_id: n.id, x, y, label: n.label },
      });
    } else {
      recipe.items.push({
        intent: "add_node",
        params: { node_id: n.id, type: n.type, x, y, label: n.label },
      });
    }
  }
  const knownIds = new Set(observed.map((n) => n.id));
  state.edges.forEach((e, i) => {
    check(knownIds.has(e.a) && knownIds.has(e.b), "edge " + i + " endpoints are known nodes");
    check(EDGE_CATS.indexOf(e.cat) !== -1, "edge " + i + " has a known category");
    recipe.items.push({ intent: "connect", params: { a: e.a, b: e.b, cat: e.cat } });
  });
  const sysNode = observed.find((n) => n.type === "system");
  check(!!sysNode, "a system node exists for the retention annotation");
  recipe.items.push({
    intent: "set_retention",
    params: {
      node_id: sysNode.id,
      record_type: RETENTION.record_type,
      range_min_years: RETENTION.range_min_years,
      range_max_years: RETENTION.range_max_years,
      statute: RETENTION.statute,
      as_of: AS_OF,
    },
  });
  recipe.items.push({ intent: "run_check", params: { checks: CHECKS.slice() } });
  recipe.items.push({ intent: "export", params: { format: "xls" } });
  console.log(
    "[" + name + "] recipe: " + K + " nodes, " + state.edges.length + " edges, " +
      recipe.items.length + " items"
  );

  // Drive the Executor+Recorder through exactly that action sequence. The
  // export is recorded only after the page's own Excel download fires.
  const { Executor } = await import(pathToFileURL(path.join(libDir, "executor.mjs")).href);
  const { Recorder } = await import(pathToFileURL(path.join(libDir, "recorder.mjs")).href);
  const executor = new Executor(recipe, specsDir);
  const recorder = new Recorder({ executor, shard: "pilot-import-basic", domain, recipe });
  for (const item of recipe.items) {
    if (item.intent === "export") {
      const dl = await confirmExportDownload(client);
      check(dl.type.indexOf("ms-excel") !== -1, "page export fired an .xls download");
      console.log("  ok - download fired: type=" + dl.type + " size=" + dl.size);
    }
    await recorder.rec(item.intent, item.params);
  }
  const { jsonlPath, manifestPath } = await recorder.writeShard(outDir);
  check(fs.existsSync(jsonlPath), "shard written: " + jsonlPath);

  return {
    name,
    domain,
    nodes: K,
    edges: state.edges.length,
    actions: recipe.items.length,
    records: recorder.records.length,
    shard: "pilot-import-basic",
    jsonlPath,
    manifestPath,
  };
}
