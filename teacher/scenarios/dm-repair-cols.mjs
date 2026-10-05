/* scenarios/dm-repair-cols.mjs - in-domain teacher scenario: broken-column repair.
 *
 * Scripted beats: the recipe contains a connect from n1 to n9, but n9 is
 * never added before that item. The executor rejects the dangling connect
 * at its precondition, so the scenario catches the rejection, records a
 * skip_recipe_item (with a 1-200 char reason) for the failed item index,
 * then adds n9 properly and replays the connect. Deterministic: fixed
 * coordinates, fixed labels, fixed as_of date.
 * RNG note: mulberry32 seed 20260915; all values below are fixed literals.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "dm-repair-cols";
export const domain = "data-mapping/dm-repair-cols";

const AS_OF = "2026-09-15";
const PIPEDA = "Personal Information Protection and Electronic Documents Act, S.C. 2000, c. 5, s. 8";

const recipe = {
  name: "Newsletter list map with an in-band repair of a dangling column",
  recipe_id: "p4-dm-repair-cols-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 200, label: "Newsletter signup form" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 60, label: "Primary email platform" } },
    { intent: "add_node", params: { node_id: "n3", type: "system", x: 300, y: 150, label: "Subscriber list database" } },
    { intent: "add_node", params: { node_id: "n4", type: "system", x: 300, y: 240, label: "Preference center" } },
    { intent: "add_node", params: { node_id: "n5", type: "thirdparty", x: 540, y: 100, label: "Email delivery vendor" } },
    { intent: "add_node", params: { node_id: "n6", type: "thirdparty", x: 540, y: 200, label: "List hygiene service" } },
    { intent: "add_node", params: { node_id: "n7", type: "destruction", x: 540, y: 300, label: "Unsubscribe purge bin" } },
    { intent: "add_node", params: { node_id: "n8", type: "system", x: 300, y: 330, label: "Campaign event log" } },
    // Broken column: n9 does not exist yet when this item runs.
    { intent: "connect", params: { a: "n1", b: "n9", cat: "contact" } },
    { intent: "add_node", params: { node_id: "n9", type: "system", x: 160, y: 330, label: "Double opt-in audit trail" } },
    { intent: "connect", params: { a: "n1", b: "n9", cat: "contact" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n5", cat: "marketing" } },
    { intent: "connect", params: { a: "n3", b: "n6", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n7", cat: "contact" } },
    {
      intent: "set_retention",
      params: { node_id: "n1", record_type: "Newsletter consent records", verify_only: true, as_of: AS_OF },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n9", record_type: "Consent audit records",
        range_min_years: 1, range_max_years: 2, statute: PIPEDA, as_of: AS_OF,
      },
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
  for (const k of [0, 1, 2, 3, 4, 5, 6, 7]) recorder.rec(it[k].intent, it[k].params);
  // Item 8 is the dangling connect (n9 was never added): the executor
  // rejects the precondition, so record a skip for that item index instead.
  try {
    recorder.rec(it[8].intent, it[8].params);
  } catch (err) {
    const skipEntry = executor.validMenu().find((e) => e.action_name === "skip_recipe_item");
    recorder.rec("skip_recipe_item", {
      item_index: skipEntry.params.item_index,
      reason: "Dangling column: connect target n9 is not on the canvas yet; skipping to repair in-band.",
    });
  }
  // Repair: add n9 properly, then replay the connect.
  for (const k of [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]) recorder.rec(it[k].intent, it[k].params);
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
