/* scenarios/dm-adv-doubleflag.mjs - adversarial teacher scenario: two flags, different grounds.
 *
 * Corruption: none in the recipe; the teacher flags twice on different
 * grounds at different points in the build (item 2: unapproved payroll
 * vendor; item 5: undocumented purge schedule).
 * Recovery (gold): each flag_for_review carries reason plus item_index and
 * is cleared in-band with undo_last; the session then finishes clean with
 * checks and export.
 * Deterministic: fixed labels/coords/dates, as_of 2026-09-15.
 * RNG: mulberry32(20260915); coordinates are fixed literals, the seed
 * documents the (unused) stream.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "dm-adv-doubleflag";
export const domain = "data-mapping/dm-adv-doubleflag";

const AS_OF = "2026-09-15";
const TAX = "Income Tax Act, R.S.C. 1985, c. 1 (5th Supp.), s. 230(4)(b)";

const recipe = {
  name: "Adversarial: vendor map with two review flags on different grounds",
  recipe_id: "p4-dm-adv-doubleflag-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 100, label: "Vendor onboarding form" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 80, label: "Vendor master DB" } },
    { intent: "add_node", params: { node_id: "n3", type: "thirdparty", x: 540, y: 120, label: "Payroll processor" } },
    { intent: "add_node", params: { node_id: "n4", type: "system", x: 300, y: 200, label: "Invoice scanner" } },
    { intent: "add_node", params: { node_id: "n5", type: "destruction", x: 540, y: 300, label: "Purge bin P-9" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n3", cat: "payment" } },
    { intent: "connect", params: { a: "n2", b: "n4", cat: "contact" } },
    {
      intent: "set_retention",
      params: { node_id: "n2", record_type: "Vendor records", verify_only: true, as_of: AS_OF },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n3", record_type: "Payroll records",
        range_min_years: 6, range_max_years: 7, statute: TAX, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: { node_id: "n4", record_type: "Invoice images", verify_only: true, as_of: AS_OF },
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
  // First flag: the payroll processor arrived before any contract terms.
  recorder.rec("flag_for_review", {
    reason: "payroll processor added before any contract terms are on the map: confirm the vendor is approved",
    item_index: 2,
  });
  recorder.rec("undo_last", {});
  for (const k of [3, 4, 5]) recorder.rec(it[k].intent, it[k].params);
  // Second flag, different ground: the purge bin schedule is undocumented.
  recorder.rec("flag_for_review", {
    reason: "purge bin P-9 has no documented schedule: confirm destruction actually runs before export",
    item_index: 5,
  });
  recorder.rec("undo_last", {});
  for (const k of [6, 7, 8, 9, 10, 11, 12]) recorder.rec(it[k].intent, it[k].params);
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
