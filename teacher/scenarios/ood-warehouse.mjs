/* scenarios/ood-warehouse.mjs - out-of-domain teacher scenario: warehouse zones.
 *
 * Same frozen grammar, different domain: collection is the receiving dock,
 * systems are aisle 1, aisle 2, and the packing bench, thirdparty is the
 * 3PL carrier, destruction is the damage bin. Scripted beats: 18 actions,
 * including a connect chain receiving dock to aisles to packing bench to
 * 3PL carrier, ranged retention citations on the receiving dock and the
 * packing bench, a retention_cited plus connectivity check, and a final
 * export. Deterministic: fixed coordinates, fixed labels, fixed as_of
 * date, seeded RNG (mulberry32, seed 66006) available but unused since
 * every value is fixed.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "ood-warehouse";
export const domain = "ood-warehouse";

const AS_OF = "2026-09-15";
const STATUTE_LIMIT = "Limitation Act, 2002, S.O. 2002, c. 24, Sched. B, s. 5";
const STATUTE_TAX = "Income Tax Act, R.S.C., 1985, c. 1 (5th Supp.), s. 230(4)(b)";

// mulberry32, seed 66006. The scenario is fully scripted, so this is never
// called; the seed documents the deterministic tie-break order for any
// future layout variant of this plugin.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
void mulberry32;

const recipe = {
  name: "OOD: warehouse zones map (receiving, aisles, packing, 3PL, damage bin)",
  recipe_id: "p4-ood-warehouse-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 100, label: "Receiving dock" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 280, y: 90, label: "Aisle 1" } },
    { intent: "add_node", params: { node_id: "n3", type: "system", x: 280, y: 220, label: "Aisle 2" } },
    { intent: "add_node", params: { node_id: "n4", type: "system", x: 440, y: 150, label: "Packing bench" } },
    { intent: "add_node", params: { node_id: "n5", type: "thirdparty", x: 580, y: 90, label: "3PL carrier Fastlane" } },
    { intent: "add_node", params: { node_id: "n6", type: "destruction", x: 580, y: 300, label: "Damage bin" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n1", b: "n3", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n4", cat: "contact" } },
    { intent: "connect", params: { a: "n3", b: "n4", cat: "contact" } },
    { intent: "connect", params: { a: "n4", b: "n5", cat: "contact" } },
    {
      intent: "set_retention",
      params: {
        node_id: "n1", record_type: "Goods receipt records",
        range_min_years: 6, range_max_years: 7, statute: STATUTE_TAX, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n4", record_type: "Packing slip records",
        range_min_years: 2, range_max_years: 3, statute: STATUTE_LIMIT, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n2", record_type: "Aisle 1 stock records",
        range_min_years: 2, range_max_years: 3, statute: STATUTE_LIMIT, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n3", record_type: "Aisle 2 stock records",
        range_min_years: 2, range_max_years: 3, statute: STATUTE_LIMIT, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: { node_id: "n5", record_type: "Carrier handoff log", verify_only: true, as_of: AS_OF },
    },
    { intent: "run_check", params: { checks: ["retention_cited", "connectivity"] } },
    { intent: "export", params: { format: "xls" } },
  ],
};

export async function run(ctx) {
  const { libDir, specsDir, outDir } = ctx;
  const { Executor } = await import(pathToFileURL(join(libDir, "executor.mjs")).href);
  const { Recorder } = await import(pathToFileURL(join(libDir, "recorder.mjs")).href);
  const executor = new Executor(recipe, specsDir);
  const recorder = new Recorder({ executor, shard: name, domain, recipe });

  const it = recipe.items;
  for (let k = 0; k < it.length; k++) recorder.rec(it[k].intent, it[k].params);
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
