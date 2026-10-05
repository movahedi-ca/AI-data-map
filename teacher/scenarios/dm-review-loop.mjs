/* scenarios/dm-review-loop.mjs - in-domain teacher scenario: review loop.
 *
 * Scripted beats: 5 nodes, a flag_for_review (reason plus item_index)
 * opened on an uncertain thirdparty, cleared in-band with undo_last, a
 * confirm_node on the collection point, a verify_only retention citation
 * plus one ranged statute entry, a retention_cited check, and an xls
 * export. Deterministic: fixed coordinates, fixed labels, fixed as_of date.
 * RNG note: mulberry32 seed 20260915; all values below are fixed literals.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "dm-review-loop";
export const domain = "data-mapping/dm-review-loop";

const AS_OF = "2026-09-15";
const PIPEDA = "Personal Information Protection and Electronic Documents Act, S.C. 2000, c. 5, s. 8";

const recipe = {
  name: "Cookie consent map with a review flag on an uncertain ad partner",
  recipe_id: "p4-dm-review-loop-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 200, label: "Cookie consent banner v2" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 120, label: "Consent management platform" } },
    { intent: "add_node", params: { node_id: "n3", type: "thirdparty", x: 540, y: 120, label: "Ad exchange partner (scope under review)" } },
    { intent: "add_node", params: { node_id: "n4", type: "system", x: 300, y: 280, label: "Consent log archive" } },
    { intent: "add_node", params: { node_id: "n5", type: "destruction", x: 540, y: 280, label: "Expired consent purge" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n3", cat: "marketing" } },
    { intent: "connect", params: { a: "n2", b: "n4", cat: "contact" } },
    { intent: "connect", params: { a: "n4", b: "n5", cat: "contact" } },
    { intent: "confirm_node", params: { node_id: "n1", note: "Banner wording matches the deployed site build." } },
    {
      intent: "set_retention",
      params: { node_id: "n2", record_type: "Consent receipts", verify_only: true, as_of: AS_OF },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n4", record_type: "Consent records",
        range_min_years: 1, range_max_years: 2, statute: PIPEDA, as_of: AS_OF,
      },
    },
    { intent: "run_check", params: { checks: ["retention_cited"] } },
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
  for (const k of [0, 1, 2, 3, 4]) recorder.rec(it[k].intent, it[k].params);
  // Uncertain ad partner: flag for review on the upcoming connect item, then clear in-band.
  recorder.rec("flag_for_review", {
    reason: "Ad exchange scope is uncertain: vendor claims only bid telemetry, contract suggests profile data.",
    item_index: 6,
  });
  recorder.rec("undo_last", {});
  for (const k of [5, 6, 7, 8, 9, 10, 11, 12, 13]) recorder.rec(it[k].intent, it[k].params);
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
