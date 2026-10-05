/* scenarios/ood-content.mjs - out-of-domain teacher scenario: editorial pipeline.
 *
 * Same frozen grammar, different domain: collection is the draft inbox,
 * systems are the CMS and the newsletter tool, thirdparty is the freelance
 * writer pool, destruction is archived drafts. Scripted beats: 13 actions,
 * including a skipped recipe item (the review calendar is out of pilot
 * scope), a four-node chain draft->CMS->writers->newsletter, a coordinate
 * move on the CMS node, and an edge_categories check. Deterministic: fixed
 * coordinates, fixed labels, no clock or random input.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "ood-content";
export const domain = "ood-content-pipeline";

const recipe = {
  name: "Pilot OOD: editorial pipeline map (inbox, CMS, writers, archive)",
  recipe_id: "pilot-ood-content-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 90, label: "Draft inbox" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 90, label: "CMS" } },
    { intent: "add_node", params: { node_id: "n3", type: "thirdparty", x: 540, y: 90, label: "Freelance writer pool" } },
    { intent: "add_node", params: { node_id: "n4", type: "destruction", x: 540, y: 300, label: "Archived drafts" } },
    // Out of pilot scope: skipped at runtime. The seq stays at 4, so the
    // newsletter tool below still takes n5.
    { intent: "add_node", params: { node_id: "n5", type: "system", x: 300, y: 220, label: "Review calendar" } },
    { intent: "add_node", params: { node_id: "n5", type: "system", x: 300, y: 250, label: "Newsletter tool" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n3", cat: "marketing" } },
    { intent: "connect", params: { a: "n3", b: "n5", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n4", cat: "contact" } },
    { intent: "set_field", params: { node_id: "n2", field: "x", value: 340 } },
    { intent: "run_check", params: { checks: ["edge_categories"] } },
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
  for (const k of [0, 1, 2, 3]) recorder.rec(it[k].intent, it[k].params);
  // Skip the review calendar: it is out of pilot scope.
  recorder.rec("skip_recipe_item", { item_index: 4, reason: "Review calendar is out of pilot scope." });
  for (const k of [5, 6, 7, 8, 9, 10, 11, 12]) recorder.rec(it[k].intent, it[k].params);
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
