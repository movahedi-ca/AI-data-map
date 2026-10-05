/* scenarios/dm-saas-scale.mjs - in-domain teacher scenario: SaaS scale-out map.
 *
 * Scripted beats: 10 nodes (1 collection, 5 systems, 3 thirdparty, 1
 * destruction), 12 edges across the contact, payment, and marketing
 * categories, set_retention on 4 nodes (one verify_only plus three ranged
 * entries with statutes), a run_check over all four checks, and an xls
 * export. Deterministic: fixed coordinates, fixed labels, fixed as_of date.
 * RNG note: mulberry32 seed 20260915; all values below are fixed literals.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "dm-saas-scale";
export const domain = "data-mapping/dm-saas-scale";

const AS_OF = "2026-09-15";
const TAX_ACT = "Income Tax Act (Canada), RSC 1985, c. 1 (5th Supp.), s. 230(4)(b)";
const LIMIT_ACT = "Limitation Act, 2002, S.O. 2002, c. 24, Sched. B, s. 5";
const PIPEDA = "Personal Information Protection and Electronic Documents Act, S.C. 2000, c. 5, s. 8";

const recipe = {
  name: "SaaS scale-out map: signup, billing, CRM, marketing, support, purge",
  recipe_id: "p4-dm-saas-scale-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 200, label: "Free trial signup page" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 60, label: "Billing system" } },
    { intent: "add_node", params: { node_id: "n3", type: "system", x: 300, y: 150, label: "CRM contact store" } },
    { intent: "add_node", params: { node_id: "n4", type: "system", x: 300, y: 240, label: "Marketing automation platform" } },
    { intent: "add_node", params: { node_id: "n5", type: "system", x: 300, y: 330, label: "Product analytics warehouse" } },
    { intent: "add_node", params: { node_id: "n6", type: "system", x: 540, y: 150, label: "Support ticket system" } },
    { intent: "add_node", params: { node_id: "n7", type: "thirdparty", x: 540, y: 60, label: "Payment processor PayNorth" } },
    { intent: "add_node", params: { node_id: "n8", type: "thirdparty", x: 540, y: 240, label: "Cloud email vendor" } },
    { intent: "add_node", params: { node_id: "n9", type: "thirdparty", x: 540, y: 330, label: "Ad network Beacon Ads" } },
    { intent: "add_node", params: { node_id: "n10", type: "destruction", x: 420, y: 200, label: "Inactive account purge queue" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n1", b: "n3", cat: "contact" } },
    { intent: "connect", params: { a: "n1", b: "n4", cat: "marketing" } },
    { intent: "connect", params: { a: "n2", b: "n7", cat: "payment" } },
    { intent: "connect", params: { a: "n2", b: "n10", cat: "contact" } },
    { intent: "connect", params: { a: "n3", b: "n5", cat: "contact" } },
    { intent: "connect", params: { a: "n3", b: "n8", cat: "marketing" } },
    { intent: "connect", params: { a: "n3", b: "n9", cat: "contact" } },
    { intent: "connect", params: { a: "n4", b: "n8", cat: "marketing" } },
    { intent: "connect", params: { a: "n6", b: "n3", cat: "contact" } },
    { intent: "connect", params: { a: "n6", b: "n8", cat: "marketing" } },
    { intent: "connect", params: { a: "n2", b: "n6", cat: "payment" } },
    {
      intent: "set_retention",
      params: { node_id: "n1", record_type: "Signup form submissions", verify_only: true, as_of: AS_OF },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n2", record_type: "Billing records",
        range_min_years: 6, range_max_years: 7, statute: TAX_ACT, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n7", record_type: "Payment processing logs",
        range_min_years: 2, range_max_years: 3, statute: LIMIT_ACT, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n3", record_type: "Customer contact records",
        range_min_years: 1, range_max_years: 2, statute: PIPEDA, as_of: AS_OF,
      },
    },
    { intent: "run_check", params: { checks: ["label_coverage", "connectivity", "retention_cited", "edge_categories"] } },
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
  for (const k of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) recorder.rec(it[k].intent, it[k].params);
  for (const k of [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]) recorder.rec(it[k].intent, it[k].params);
  for (const k of [22, 23, 24, 25, 26, 27]) recorder.rec(it[k].intent, it[k].params);
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
