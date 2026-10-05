/* scenarios/ood-asset.mjs - out-of-domain teacher scenario: IT asset inventory.
 *
 * Same frozen grammar, different domain: collection is procurement intake,
 * systems are the MDM asset database and the helpdesk queue, thirdparty is
 * the leasing vendor, destruction is decommissioned devices. Scripted beats:
 * 18 actions, including two undos (a mislabeled node, then a review flag
 * opened with a node_id and cleared in-band), retention citations on every
 * system and thirdparty node, a retention_cited check, and an abort_session
 * at the end that seals the terminated snapshot. Deterministic: fixed
 * coordinates, fixed labels, fixed as_of date.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "ood-asset";
export const domain = "ood-asset-inventory";

const AS_OF = "2026-09-15";
const STATUTE = "Limitation Act, 2002, S.O. 2002, c. 24, Sched. B, s. 5";
const STATUTE_TAX = "Income Tax Act, R.S.C., 1985, c. 1 (5th Supp.), s. 230(4)(b)";

const recipe = {
  name: "Pilot OOD: IT asset inventory map (intake, MDM, leasing, decommissioned)",
  recipe_id: "pilot-ood-asset-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 90, label: "Procurement intake" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 80, label: "MDM asset database" } },
    { intent: "add_node", params: { node_id: "n3", type: "thirdparty", x: 540, y: 120, label: "Leasing vendor Northline" } },
    { intent: "add_node", params: { node_id: "n4", type: "destruction", x: 540, y: 300, label: "Decommissioned devices" } },
    // Wrong label: should have been the ITSM queue. Undone next.
    { intent: "add_node", params: { node_id: "n5", type: "system", x: 300, y: 220, label: "Helpdesk ticket queue" } },
    // Re-added correctly. The seq is monotonic, so this is n6.
    { intent: "add_node", params: { node_id: "n6", type: "system", x: 300, y: 240, label: "Helpdesk ticket queue (ITSM)" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n3", cat: "payment" } },
    { intent: "connect", params: { a: "n2", b: "n6", cat: "contact" } },
    { intent: "connect", params: { a: "n6", b: "n4", cat: "contact" } },
    {
      intent: "set_retention",
      params: {
        node_id: "n2", record_type: "Capital asset acquisition records",
        range_min_years: 6, range_max_years: 7, statute: STATUTE_TAX, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n6", record_type: "IT support ticket records",
        range_min_years: 2, range_max_years: 3, statute: STATUTE, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n3", record_type: "Lease agreement records",
        range_min_years: 6, range_max_years: 7, statute: STATUTE_TAX, as_of: AS_OF,
      },
    },
    { intent: "run_check", params: { checks: ["retention_cited"] } },
  ],
};

export async function run(ctx) {
  const { libDir, specsDir, outDir } = ctx;
  const { Executor } = await import(pathToFileURL(join(libDir, "executor.mjs")).href);
  const { Recorder } = await import(pathToFileURL(join(libDir, "recorder.mjs")).href);
  const executor = new Executor(recipe, specsDir);
  const recorder = new Recorder({ executor, shard: name, domain, recipe });

  const it = recipe.items;
  for (const k of [0, 1, 2, 3, 4]) recorder.rec(it[k].intent, it[k].params);
  recorder.rec("undo_last", {});            // remove the mislabeled n5
  recorder.rec(it[5].intent, it[5].params); // re-add correctly as n6
  for (const k of [6, 7]) recorder.rec(it[k].intent, it[k].params);
  // Leasing terms under review: flag with a node_id, then clear in-band.
  recorder.rec("flag_for_review", { node_id: "n3", reason: "Leasing terms under review by finance." });
  recorder.rec("undo_last", {});            // clears the review flag
  for (const k of [8, 9, 10, 11, 12, 13]) recorder.rec(it[k].intent, it[k].params);
  // Teach the abort grammar: the pilot ends here, the snapshot is sealed.
  recorder.rec("abort_session", { reason: "pilot scope complete, inventory handed to owner" });
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
