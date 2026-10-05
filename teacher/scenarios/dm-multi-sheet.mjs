/* scenarios/dm-multi-sheet.mjs - in-domain teacher scenario: two collection points.
 *
 * Scripted beats: two collection points (mobile app registration and the
 * website lead form) share a common systems layer, 8 nodes total, 9 edges,
 * a ranged retention citation on the shared customer database, a
 * connectivity check, and an xls export. Deterministic: fixed
 * coordinates, fixed labels, fixed as_of date.
 * RNG note: mulberry32 seed 20260915; all values below are fixed literals.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "dm-multi-sheet";
export const domain = "data-mapping/dm-multi-sheet";

const AS_OF = "2026-09-15";
const PIPEDA = "Personal Information Protection and Electronic Documents Act, S.C. 2000, c. 5, s. 8";

const recipe = {
  name: "Two collection points sharing one systems layer (app plus web)",
  recipe_id: "p4-dm-multi-sheet-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 60, y: 100, label: "Mobile app registration" } },
    { intent: "add_collection_point", params: { node_id: "n2", x: 60, y: 280, label: "Website lead form" } },
    { intent: "add_node", params: { node_id: "n3", type: "system", x: 300, y: 100, label: "Customer master database" } },
    { intent: "add_node", params: { node_id: "n4", type: "system", x: 300, y: 200, label: "Marketing data lake" } },
    { intent: "add_node", params: { node_id: "n5", type: "system", x: 300, y: 300, label: "Notification service" } },
    { intent: "add_node", params: { node_id: "n6", type: "thirdparty", x: 540, y: 160, label: "SMS gateway vendor" } },
    { intent: "add_node", params: { node_id: "n7", type: "thirdparty", x: 540, y: 260, label: "Analytics vendor" } },
    { intent: "add_node", params: { node_id: "n8", type: "destruction", x: 420, y: 360, label: "Stale lead purge" } },
    { intent: "connect", params: { a: "n1", b: "n3", cat: "contact" } },
    { intent: "connect", params: { a: "n1", b: "n4", cat: "marketing" } },
    { intent: "connect", params: { a: "n2", b: "n3", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n4", cat: "marketing" } },
    { intent: "connect", params: { a: "n3", b: "n5", cat: "contact" } },
    { intent: "connect", params: { a: "n4", b: "n5", cat: "marketing" } },
    { intent: "connect", params: { a: "n5", b: "n6", cat: "contact" } },
    { intent: "connect", params: { a: "n4", b: "n7", cat: "marketing" } },
    { intent: "connect", params: { a: "n3", b: "n8", cat: "contact" } },
    {
      intent: "set_retention",
      params: {
        node_id: "n3", record_type: "Customer profile records",
        range_min_years: 1, range_max_years: 2, statute: PIPEDA, as_of: AS_OF,
      },
    },
    { intent: "run_check", params: { checks: ["connectivity"] } },
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
  for (const k of [0, 1, 2, 3, 4, 5, 6, 7]) recorder.rec(it[k].intent, it[k].params);
  for (const k of [8, 9, 10, 11, 12, 13, 14, 15, 16]) recorder.rec(it[k].intent, it[k].params);
  for (const k of [17, 18, 19]) recorder.rec(it[k].intent, it[k].params);
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
