/* scenarios/ood-adv-abort.mjs - adversarial teacher scenario: abort, asset-inventory flavor.
 *
 * Corruption: the recipe builds a partial asset register, then its tail is
 * four connect items that all reference nodes never added (n7, n8, n9).
 * Every remaining item dangles.
 * Recovery (gold): the teacher tries the first dangling connect, skips it;
 * tries the second, skips it; then aborts the session with the reason
 * "no buildable items remain" instead of grinding through certain failures.
 * Deterministic: fixed labels/coords/dates, as_of 2026-09-15.
 * RNG: mulberry32(20260915); coordinates are fixed literals, the seed
 * documents the (unused) stream.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "ood-adv-abort";
export const domain = "ood-asset-inventory";

const AS_OF = "2026-09-15";
const TAX = "Income Tax Act, R.S.C. 1985, c. 1 (5th Supp.), s. 230(4)(b)";

const recipe = {
  name: "Adversarial: asset register whose tail of connects all dangle; abort",
  recipe_id: "p4-ood-adv-abort-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 100, label: "Asset intake desk" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 80, label: "Asset register" } },
    { intent: "add_node", params: { node_id: "n3", type: "system", x: 300, y: 200, label: "Depreciation ledger" } },
    { intent: "add_node", params: { node_id: "n4", type: "thirdparty", x: 540, y: 140, label: "Disposal contractor" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n3", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n4", cat: "contact" } },
    {
      intent: "set_retention",
      params: { node_id: "n2", record_type: "Asset records", verify_only: true, as_of: AS_OF },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n3", record_type: "Depreciation records",
        range_min_years: 6, range_max_years: 7, statute: TAX, as_of: AS_OF,
      },
    },
    { intent: "connect", params: { a: "n2", b: "n7", cat: "contact" } },
    { intent: "connect", params: { a: "n3", b: "n8", cat: "contact" } },
    { intent: "connect", params: { a: "n4", b: "n9", cat: "marketing" } },
    { intent: "connect", params: { a: "n1", b: "n7", cat: "contact" } },
  ],
};

export async function run(ctx) {
  const { libDir, specsDir, outDir } = ctx;
  const { Executor } = await import(pathToFileURL(join(libDir, "executor.mjs")).href);
  const { Recorder } = await import(pathToFileURL(join(libDir, "recorder.mjs")).href);
  const executor = new Executor(recipe, specsDir);
  const recorder = new Recorder({ executor, shard: name, domain, recipe });

  function skipDangling(it, k, target) {
    try {
      recorder.rec(it[k].intent, it[k].params);
      throw new Error("expected the dangling connect at item " + k + " to be rejected");
    } catch (e) {
      if (!/does not exist/.test(e.message)) throw e;
      recorder.rec("skip_recipe_item", {
        item_index: k,
        reason: "connect target " + target + " was never added to the canvas; skipping the dangling item",
      });
    }
  }

  const it = recipe.items;
  for (const k of [0, 1, 2, 3, 4, 5, 6, 7, 8]) recorder.rec(it[k].intent, it[k].params);
  // The tail dangles: items 9..12 reference nodes never added. Skip two to
  // confirm the pattern, then abort instead of failing through the rest.
  skipDangling(it, 9, "n7");
  skipDangling(it, 10, "n8");
  recorder.rec("abort_session", { reason: "no buildable items remain" });
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
