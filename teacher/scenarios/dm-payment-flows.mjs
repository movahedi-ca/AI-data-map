/* scenarios/dm-payment-flows.mjs - in-domain teacher scenario: payment flows.
 *
 * Scripted beats: payment-category edges from a checkout collection point
 * to processor thirdparties (gateway, fraud screening, payout), a refund
 * ledger system, and an abandoned cart purge; two ranged retention entries
 * with statutes on the gateway and the refund ledger; checks over
 * retention_cited and edge_categories; xls export. Deterministic: fixed
 * coordinates, fixed labels, fixed as_of date.
 * RNG note: mulberry32 seed 20260915; all values below are fixed literals.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "dm-payment-flows";
export const domain = "data-mapping/dm-payment-flows";

const AS_OF = "2026-09-15";
const TAX_ACT = "Income Tax Act (Canada), RSC 1985, c. 1 (5th Supp.), s. 230(4)(b)";
const LIMIT_ACT = "Limitation Act, 2002, S.O. 2002, c. 24, Sched. B, s. 5";

const recipe = {
  name: "Checkout payment flows: gateway, fraud screening, refunds, payouts",
  recipe_id: "p4-dm-payment-flows-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 200, label: "Checkout page" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 120, label: "Order database" } },
    { intent: "add_node", params: { node_id: "n3", type: "thirdparty", x: 540, y: 80, label: "Payment gateway NorthPay" } },
    { intent: "add_node", params: { node_id: "n4", type: "thirdparty", x: 540, y: 200, label: "Fraud screening vendor" } },
    { intent: "add_node", params: { node_id: "n5", type: "system", x: 300, y: 260, label: "Refund ledger" } },
    { intent: "add_node", params: { node_id: "n6", type: "thirdparty", x: 540, y: 320, label: "Payout processor" } },
    { intent: "add_node", params: { node_id: "n7", type: "destruction", x: 160, y: 330, label: "Abandoned cart purge" } },
    { intent: "connect", params: { a: "n1", b: "n3", cat: "payment" } },
    { intent: "connect", params: { a: "n1", b: "n4", cat: "payment" } },
    { intent: "connect", params: { a: "n3", b: "n2", cat: "payment" } },
    { intent: "connect", params: { a: "n4", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n5", cat: "payment" } },
    { intent: "connect", params: { a: "n5", b: "n6", cat: "payment" } },
    { intent: "connect", params: { a: "n1", b: "n7", cat: "contact" } },
    {
      intent: "set_retention",
      params: {
        node_id: "n3", record_type: "Transaction authorization records",
        range_min_years: 6, range_max_years: 7, statute: TAX_ACT, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n5", record_type: "Refund records",
        range_min_years: 2, range_max_years: 3, statute: LIMIT_ACT, as_of: AS_OF,
      },
    },
    { intent: "run_check", params: { checks: ["retention_cited", "edge_categories"] } },
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
  for (const k of [7, 8, 9, 10, 11, 12, 13]) recorder.rec(it[k].intent, it[k].params);
  for (const k of [14, 15, 16, 17]) recorder.rec(it[k].intent, it[k].params);
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
