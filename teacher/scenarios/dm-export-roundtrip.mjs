/* scenarios/dm-export-roundtrip.mjs - in-domain teacher scenario: export roundtrip.
 *
 * Scripted beats: 6 nodes and 5 edges forming a small support-desk map,
 * one confirm_node, one xls export, then a second run_check after the
 * export to show checks keep passing on the finished canvas. Deterministic:
 * fixed coordinates, fixed labels, fixed as_of date.
 * RNG note: mulberry32 seed 20260915; all values below are fixed literals.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "dm-export-roundtrip";
export const domain = "data-mapping/dm-export-roundtrip";

const AS_OF = "2026-09-15";
const PIPEDA = "Personal Information Protection and Electronic Documents Act, S.C. 2000, c. 5, s. 8";

const recipe = {
  name: "Support desk map: export, then re-run checks on the finished canvas",
  recipe_id: "p4-dm-export-roundtrip-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 200, label: "Contact us form" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 120, label: "Ticketing system" } },
    { intent: "add_node", params: { node_id: "n3", type: "thirdparty", x: 540, y: 120, label: "Chat widget vendor" } },
    { intent: "add_node", params: { node_id: "n4", type: "system", x: 300, y: 280, label: "Knowledge base" } },
    { intent: "add_node", params: { node_id: "n5", type: "destruction", x: 540, y: 280, label: "Closed ticket archive" } },
    { intent: "add_node", params: { node_id: "n6", type: "system", x: 160, y: 330, label: "Follow-up queue" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n1", b: "n3", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n4", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n6", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n5", cat: "contact" } },
    { intent: "confirm_node", params: { node_id: "n1", note: "Form fields match the live contact page." } },
    {
      intent: "set_retention",
      params: {
        node_id: "n2", record_type: "Support ticket records",
        range_min_years: 1, range_max_years: 2, statute: PIPEDA, as_of: AS_OF,
      },
    },
    { intent: "export", params: { format: "xls" } },
    { intent: "run_check", params: { checks: ["label_coverage", "connectivity", "retention_cited"] } },
  ],
};

export async function run(ctx) {
  const { libDir, specsDir, outDir } = ctx;
  const { Executor } = await import(pathToFileURL(join(libDir, "executor.mjs")).href);
  const { Recorder } = await import(pathToFileURL(join(libDir, "recorder.mjs")).href);
  const executor = new Executor(recipe, specsDir);
  const recorder = new Recorder({ executor, shard: name, domain, recipe });

  const it = recipe.items;
  for (const k of [0, 1, 2, 3, 4, 5]) recorder.rec(it[k].intent, it[k].params);
  for (const k of [6, 7, 8, 9, 10, 11, 12]) recorder.rec(it[k].intent, it[k].params);
  // Export first, then re-run the checks on the finished canvas.
  for (const k of [13, 14]) recorder.rec(it[k].intent, it[k].params);
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
