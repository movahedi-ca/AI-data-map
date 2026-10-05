/* scenarios/dm-adv-flagstorm.mjs - adversarial teacher scenario: flag storm.
 *
 * Corruption: none in the recipe; the teacher itself grows suspicious and
 * opens three review flags in a row on different grounds (vendor scope,
 * purge schedule, thin verify-only note).
 * Recovery (gold): each flag is cleared in-band with undo_last before the
 * next one opens; the session then finishes clean with checks and export.
 * Note: the idempotency key binds (recipe_id, item_index, action_name), so
 * two flags raised at the same item index collide once the first is undone
 * and tombstoned. The teacher therefore advances one recipe item between
 * flags, giving each flag a distinct key.
 * Deterministic: fixed labels/coords/dates, as_of 2026-09-15.
 * RNG: mulberry32(20260915); coordinates are fixed literals, the seed
 * documents the (unused) stream.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "dm-adv-flagstorm";
export const domain = "data-mapping/dm-adv-flagstorm";

const AS_OF = "2026-09-15";

const recipe = {
  name: "Adversarial: hiring map with three sequential review flags, each cleared",
  recipe_id: "p4-dm-adv-flagstorm-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 100, label: "Job application portal" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 90, label: "Applicant tracking DB" } },
    { intent: "add_node", params: { node_id: "n3", type: "thirdparty", x: 540, y: 120, label: "Background check vendor" } },
    { intent: "add_node", params: { node_id: "n4", type: "destruction", x: 540, y: 300, label: "Rejection purge bin" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n3", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n4", cat: "contact" } },
    {
      intent: "set_retention",
      params: { node_id: "n2", record_type: "Hiring records", verify_only: true, as_of: AS_OF },
    },
    {
      intent: "set_retention",
      params: { node_id: "n3", record_type: "Screening reports", verify_only: true, as_of: AS_OF },
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
  for (const k of [0, 1, 2, 3, 4, 5, 6]) recorder.rec(it[k].intent, it[k].params);
  // Flag storm: three flags on distinct grounds, each cleared in-band
  // with undo_last before the next opens. One recipe item advances between
  // flags so each flag_for_review lands at a distinct item index (distinct
  // idempotency key); repeating the flag at the same index would collide
  // with the tombstoned key of the undone flag.
  recorder.rec("flag_for_review", {
    reason: "background check vendor scope is unclear: confirm which applicant fields leave the ATS before mapping the flow",
    node_id: "n3",
  });
  recorder.rec("undo_last", {});
  recorder.rec(it[7].intent, it[7].params);
  recorder.rec("flag_for_review", {
    reason: "rejection purge bin has no documented schedule: confirm the purge actually runs",
    node_id: "n4",
  });
  recorder.rec("undo_last", {});
  recorder.rec(it[8].intent, it[8].params);
  recorder.rec("flag_for_review", {
    reason: "the verify-only note on item 7 is thin: confirm what the retention owner actually attested",
    item_index: 7,
  });
  recorder.rec("undo_last", {});
  for (const k of [9, 10]) recorder.rec(it[k].intent, it[k].params);
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
