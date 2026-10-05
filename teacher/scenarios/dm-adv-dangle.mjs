/* scenarios/dm-adv-dangle.mjs - adversarial teacher scenario: dangling reference.
 *
 * Corruption: the recipe emits connect n2->n9 at item 4, but the add_node
 * for n9 only arrives at item 9 (ordering corruption in the recipe). The
 * executor rejects the connect because n9 does not exist.
 * Recovery (gold): skip_recipe_item on the failed item, then continue;
 * when n9 is added later the teacher connects n2->n9 correctly.
 * Note: add_node n9 at item 9 needs guide seq 8, so the recipe plans nine
 * node slots (n1..n9, contiguous, no gaps); the first six form the core map.
 * Deterministic: fixed labels/coords/dates, as_of 2026-09-15.
 * RNG: mulberry32(20260915); coordinates are fixed literals, the seed
 * documents the (unused) stream.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "dm-adv-dangle";
export const domain = "data-mapping/dm-adv-dangle";

const AS_OF = "2026-09-15";

const recipe = {
  name: "Adversarial: newsletter signup map with a dangling connect to n9",
  recipe_id: "p4-dm-adv-dangle-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 100, label: "Website signup form" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 80, label: "Marketing list DB" } },
    { intent: "add_node", params: { node_id: "n3", type: "system", x: 300, y: 200, label: "Email service" } },
    { intent: "add_node", params: { node_id: "n4", type: "thirdparty", x: 540, y: 120, label: "Ad network Northbeam" } },
    { intent: "connect", params: { a: "n2", b: "n9", cat: "contact" } },
    { intent: "add_node", params: { node_id: "n5", type: "system", x: 120, y: 300, label: "Preference center" } },
    { intent: "add_node", params: { node_id: "n6", type: "destruction", x: 540, y: 300, label: "Purge bin P-2" } },
    { intent: "add_node", params: { node_id: "n7", type: "destruction", x: 420, y: 300, label: "Cold archive A-1" } },
    { intent: "add_node", params: { node_id: "n8", type: "thirdparty", x: 120, y: 200, label: "SMS gateway" } },
    { intent: "add_node", params: { node_id: "n9", type: "thirdparty", x: 420, y: 180, label: "Loyalty platform" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n3", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n4", cat: "marketing" } },
    { intent: "connect", params: { a: "n2", b: "n5", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n8", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n9", cat: "contact" } },
    { intent: "run_check", params: { checks: ["connectivity", "edge_categories", "label_coverage"] } },
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
  // Item 4 dangles: n9 is not on the canvas yet. The executor rejects the
  // connect; the gold recovery is skip_recipe_item on the failed item.
  try {
    recorder.rec(it[4].intent, it[4].params);
    throw new Error("expected the dangling connect at item 4 to be rejected");
  } catch (e) {
    if (!/does not exist/.test(e.message)) throw e;
    recorder.rec("skip_recipe_item", {
      item_index: 4,
      reason: "connect target n9 is not on the canvas; its add item arrives later in the recipe",
    });
  }
  for (const k of [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]) {
    recorder.rec(it[k].intent, it[k].params);
  }
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
