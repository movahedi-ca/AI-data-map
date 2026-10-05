/* scenarios/dm-hr-workbook.mjs - in-domain teacher scenario: HR workbook.
 *
 * Scripted beats: HR-flavored labels (applicant intake form, HRIS core,
 * payroll vendor, personnel file archive, background check vendor, and a
 * retention schedule purge), 6 nodes, 6 edges, two ranged retention
 * entries with employment statutes, a retention_cited check, and an xls
 * export. Deterministic: fixed coordinates, fixed labels, fixed as_of date.
 * RNG note: mulberry32 seed 20260915; all values below are fixed literals.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "dm-hr-workbook";
export const domain = "data-mapping/dm-hr-workbook";

const AS_OF = "2026-09-15";
const ESA = "Employment Standards Act, 2000, S.O. 2000, c. 41, s. 15.1";
const CLC = "Canada Labour Code, R.S.C. 1985, c. L-2, s. 252";

const recipe = {
  name: "HR workbook: intake, HRIS, payroll vendor, archive, background check",
  recipe_id: "p4-dm-hr-workbook-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 200, label: "Job applicant intake form" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 120, label: "HRIS core" } },
    { intent: "add_node", params: { node_id: "n3", type: "thirdparty", x: 540, y: 120, label: "Payroll vendor PayCan" } },
    { intent: "add_node", params: { node_id: "n4", type: "system", x: 300, y: 280, label: "Personnel file archive" } },
    { intent: "add_node", params: { node_id: "n5", type: "thirdparty", x: 540, y: 280, label: "Background check vendor" } },
    { intent: "add_node", params: { node_id: "n6", type: "destruction", x: 160, y: 330, label: "Retention schedule purge" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n1", b: "n5", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n3", cat: "payment" } },
    { intent: "connect", params: { a: "n2", b: "n4", cat: "contact" } },
    { intent: "connect", params: { a: "n3", b: "n4", cat: "payment" } },
    { intent: "connect", params: { a: "n2", b: "n6", cat: "contact" } },
    {
      intent: "set_retention",
      params: {
        node_id: "n2", record_type: "Employee wage records",
        range_min_years: 3, range_max_years: 4, statute: ESA, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n3", record_type: "Payroll records",
        range_min_years: 3, range_max_years: 4, statute: CLC, as_of: AS_OF,
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
  for (const k of [0, 1, 2, 3, 4, 5]) recorder.rec(it[k].intent, it[k].params);
  for (const k of [6, 7, 8, 9, 10, 11]) recorder.rec(it[k].intent, it[k].params);
  for (const k of [12, 13, 14, 15]) recorder.rec(it[k].intent, it[k].params);
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
