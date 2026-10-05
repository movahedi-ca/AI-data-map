/* scenarios/dm-adv-checkfix.mjs - adversarial teacher scenario: check failure then fix.
 *
 * Corruption: the recipe builds five nodes but cites retention for only four
 * of them; the first run_check on retention_cited fails with a finding that
 * n5 (the payment processor) has no retention citation.
 * Recovery (gold): the recipe's next item sets the missing retention on n5,
 * and the second run_check passes; the session finishes with export. The
 * trace teaches check, fix, re-check.
 * Deterministic: fixed labels/coords/dates, as_of 2026-09-15.
 * RNG: mulberry32(20260915); coordinates are fixed literals, the seed
 * documents the (unused) stream.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "dm-adv-checkfix";
export const domain = "data-mapping/dm-adv-checkfix";

const AS_OF = "2026-09-15";
const TAX = "Income Tax Act, R.S.C. 1985, c. 1 (5th Supp.), s. 230(4)(b)";

const recipe = {
  name: "Adversarial: donation map where a check fails, gets fixed, and passes",
  recipe_id: "p4-dm-adv-checkfix-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 100, label: "Donation page" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 80, label: "Donor CRM" } },
    { intent: "add_node", params: { node_id: "n3", type: "system", x: 300, y: 200, label: "Receipt generator" } },
    { intent: "add_node", params: { node_id: "n4", type: "system", x: 120, y: 300, label: "Finance ledger" } },
    { intent: "add_node", params: { node_id: "n5", type: "thirdparty", x: 540, y: 140, label: "Payment processor" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n3", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n4", cat: "payment" } },
    { intent: "connect", params: { a: "n2", b: "n5", cat: "payment" } },
    {
      intent: "set_retention",
      params: { node_id: "n2", record_type: "Donor records", verify_only: true, as_of: AS_OF },
    },
    {
      intent: "set_retention",
      params: { node_id: "n3", record_type: "Receipt copies", verify_only: true, as_of: AS_OF },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n4", record_type: "Financial records",
        range_min_years: 6, range_max_years: 7, statute: TAX, as_of: AS_OF,
      },
    },
    { intent: "run_check", params: { checks: ["retention_cited"] } },
    {
      intent: "set_retention",
      params: {
        node_id: "n5", record_type: "Processor settlement records",
        range_min_years: 6, range_max_years: 7, statute: TAX, as_of: AS_OF,
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
  // Item 12 run_check fails: n5 has no retention citation. Item 13 fixes the
  // gap, item 14 re-checks and passes. The teacher executes the arc as is.
  for (const k of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
    recorder.rec(it[k].intent, it[k].params);
  }
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
