/* scenarios/dm-adv-wronglabel.mjs - adversarial teacher scenario: wrong label.
 *
 * Corruption: recipe item 2 adds n3 with the corrupted label "CMS"; the
 * intended label is "CRM". The teacher applies the item exactly, spots the
 * mislabel, and recovers.
 * Recovery (gold): undo_last removes the mislabeled node, then the
 * corrected recipe item re-adds it as n4 (guide seq is monotonic, so the
 * undone n3 id stays a tombstoned gap; that gap is the deliberate undo
 * trace, per the catalogue "undone ids leave gaps").
 * Deterministic: fixed labels/coords/dates, as_of 2026-09-15.
 * RNG: mulberry32(20260915); coordinates are fixed literals, the seed
 * documents the (unused) stream.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "dm-adv-wronglabel";
export const domain = "data-mapping/dm-adv-wronglabel";

const AS_OF = "2026-09-15";
const LIMITATION = "Limitation Act, 2002, S.O. 2002, c. 24, Sched. B, s. 5";
const TAX = "Income Tax Act, R.S.C. 1985, c. 1 (5th Supp.), s. 230(4)(b)";

const recipe = {
  name: "Adversarial: CRM rollout map with a mislabeled node, undone and re-added",
  recipe_id: "p4-dm-adv-wronglabel-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 100, label: "Sales intake form" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 80, label: "Lead router" } },
    { intent: "add_node", params: { node_id: "n3", type: "system", x: 300, y: 200, label: "CMS" } },
    { intent: "add_node", params: { node_id: "n4", type: "system", x: 300, y: 200, label: "CRM" } },
    { intent: "add_node", params: { node_id: "n5", type: "thirdparty", x: 540, y: 140, label: "Email verifier" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n4", cat: "contact" } },
    { intent: "connect", params: { a: "n4", b: "n5", cat: "contact" } },
    {
      intent: "set_retention",
      params: { node_id: "n2", record_type: "Lead routing logs", verify_only: true, as_of: AS_OF },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n4", record_type: "Customer records",
        range_min_years: 2, range_max_years: 3, statute: LIMITATION, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n5", record_type: "Verification logs",
        range_min_years: 1, range_max_years: 2, statute: TAX, as_of: AS_OF,
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
  for (const k of [0, 1, 2]) recorder.rec(it[k].intent, it[k].params);
  // Item 2 landed with the corrupted label "CMS" instead of "CRM".
  // Gold recovery: undo_last deletes the mislabeled node, then the
  // corrected item re-adds it under the next guide seq id.
  recorder.rec("undo_last", {});
  for (const k of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    recorder.rec(it[k].intent, it[k].params);
  }
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
