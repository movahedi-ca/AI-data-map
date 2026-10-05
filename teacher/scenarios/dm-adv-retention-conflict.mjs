/* scenarios/dm-adv-retention-conflict.mjs - adversarial teacher scenario: contradictory retention.
 *
 * Corruption: the recipe gives two contradictory retention instructions for
 * n2. Item 6 cites verify_only; item 7 sets a 3 to 4 year ranged retention
 * on the same node, replacing the verify-only note.
 * Recovery (gold): flag_for_review on the conflict (reason plus item_index),
 * then undo_last clears the flag in-band; the ranged citation stands and
 * the session finishes with a check and export.
 * Deterministic: fixed labels/coords/dates, as_of 2026-09-15.
 * RNG: mulberry32(20260915); coordinates are fixed literals, the seed
 * documents the (unused) stream.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "dm-adv-retention-conflict";
export const domain = "data-mapping/dm-adv-retention-conflict";

const AS_OF = "2026-09-15";
const LIMITATION = "Limitation Act, 2002, S.O. 2002, c. 24, Sched. B, s. 5";
const TAX = "Income Tax Act, R.S.C. 1985, c. 1 (5th Supp.), s. 230(4)(b)";

const recipe = {
  name: "Adversarial: support ticket map with contradictory retention on n2",
  recipe_id: "p4-dm-adv-retention-conflict-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 100, label: "Support ticket form" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 80, label: "Ticket store" } },
    { intent: "add_node", params: { node_id: "n3", type: "system", x: 300, y: 200, label: "Agent workspace" } },
    { intent: "add_node", params: { node_id: "n4", type: "thirdparty", x: 540, y: 140, label: "Chat transcript vendor" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n3", cat: "contact" } },
    {
      intent: "set_retention",
      params: { node_id: "n2", record_type: "Support ticket records", verify_only: true, as_of: AS_OF },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n2", record_type: "Support ticket records",
        range_min_years: 3, range_max_years: 4, statute: LIMITATION, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: { node_id: "n3", record_type: "Agent activity logs", verify_only: true, as_of: AS_OF },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n4", record_type: "Chat transcripts",
        range_min_years: 1, range_max_years: 2, statute: TAX, as_of: AS_OF,
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
  for (const k of [0, 1, 2, 3, 4, 5, 6, 7]) recorder.rec(it[k].intent, it[k].params);
  // Contradictory instructions for n2: item 6 said verify only, item 7 set
  // a 3 to 4 year range. Flag the conflict, then clear it in-band.
  recorder.rec("flag_for_review", {
    reason: "conflicting retention instructions for n2: item 6 says verify only, item 7 sets a 3 to 4 year range; the ranged citation replaced the verify-only note",
    item_index: 7,
  });
  recorder.rec("undo_last", {});
  for (const k of [8, 9, 10, 11]) recorder.rec(it[k].intent, it[k].params);
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
