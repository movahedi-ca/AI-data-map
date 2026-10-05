/* scenarios/ood-adv-dangle.mjs - adversarial teacher scenario: dangling reference, conference flavor.
 *
 * Corruption: the recipe emits connect n2->n7 at item 4, but the
 * "Catering vendor" add_node for n7 only arrives at item 7 (ordering
 * corruption in the recipe). The executor rejects the connect because n7
 * does not exist.
 * Recovery (gold): skip_recipe_item on the failed item, then continue;
 * when the catering vendor is added the teacher connects n2->n7 correctly
 * and finishes with checks and export.
 * Deterministic: fixed labels/coords/dates, as_of 2026-09-15.
 * RNG: mulberry32(20260915); coordinates are fixed literals, the seed
 * documents the (unused) stream.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "ood-adv-dangle";
export const domain = "ood-conference-planning";

const AS_OF = "2026-09-15";

const recipe = {
  name: "Adversarial: conference plan with a dangling connect to the catering vendor",
  recipe_id: "p4-ood-adv-dangle-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 100, label: "Registration desk" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 80, label: "Attendee list DB" } },
    { intent: "add_node", params: { node_id: "n3", type: "system", x: 300, y: 200, label: "Session scheduler" } },
    { intent: "add_node", params: { node_id: "n4", type: "thirdparty", x: 540, y: 120, label: "Venue AV provider" } },
    { intent: "connect", params: { a: "n2", b: "n7", cat: "contact" } },
    { intent: "add_node", params: { node_id: "n5", type: "system", x: 120, y: 300, label: "Badge printer queue" } },
    { intent: "add_node", params: { node_id: "n6", type: "destruction", x: 540, y: 300, label: "Shred bin S-1" } },
    { intent: "add_node", params: { node_id: "n7", type: "thirdparty", x: 420, y: 180, label: "Catering vendor" } },
    { intent: "connect", params: { a: "n2", b: "n7", cat: "contact" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n3", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n4", cat: "marketing" } },
    { intent: "connect", params: { a: "n2", b: "n5", cat: "contact" } },
    {
      intent: "set_retention",
      params: { node_id: "n2", record_type: "Attendee records", verify_only: true, as_of: AS_OF },
    },
    { intent: "run_check", params: { checks: ["connectivity", "label_coverage"] } },
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
  // Item 4 dangles: the catering vendor n7 is not on the canvas yet. The
  // executor rejects the connect; the gold recovery is skip_recipe_item.
  try {
    recorder.rec(it[4].intent, it[4].params);
    throw new Error("expected the dangling connect at item 4 to be rejected");
  } catch (e) {
    if (!/does not exist/.test(e.message)) throw e;
    recorder.rec("skip_recipe_item", {
      item_index: 4,
      reason: "catering vendor node n7 is not on the canvas yet; skipping the dangling connect",
    });
  }
  for (const k of [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
    recorder.rec(it[k].intent, it[k].params);
  }
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
