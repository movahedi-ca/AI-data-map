/* scenarios/dm-destruction-audit.mjs - in-domain teacher scenario: destruction audit.
 *
 * Scripted beats: 3 destruction nodes (deprovisioning queue, backup tape
 * rotation, document shred bin), each carrying a ranged retention entry
 * with a statute, wired to an offboarding collection point through an
 * identity store, then a connectivity check and an xls export.
 * Deterministic: fixed coordinates, fixed labels, fixed as_of date.
 * RNG note: mulberry32 seed 20260915; all values below are fixed literals.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "dm-destruction-audit";
export const domain = "data-mapping/dm-destruction-audit";

const AS_OF = "2026-09-15";
const LIMIT_ACT = "Limitation Act, 2002, S.O. 2002, c. 24, Sched. B, s. 5";
const TRUSTEE_ACT = "Trustee Act, R.S.O. 1990, c. T.23, s. 49";

const recipe = {
  name: "Offboarding destruction audit: three destruction nodes, cited ranges",
  recipe_id: "p4-dm-destruction-audit-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 200, label: "Employee offboarding checklist" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 200, label: "Identity store" } },
    { intent: "add_node", params: { node_id: "n3", type: "destruction", x: 540, y: 80, label: "Deprovisioning queue" } },
    { intent: "add_node", params: { node_id: "n4", type: "destruction", x: 540, y: 200, label: "Backup tape rotation" } },
    { intent: "add_node", params: { node_id: "n5", type: "destruction", x: 540, y: 320, label: "Document shred bin" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n3", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n4", cat: "contact" } },
    { intent: "connect", params: { a: "n1", b: "n5", cat: "contact" } },
    {
      intent: "set_retention",
      params: {
        node_id: "n3", record_type: "Access revocation records",
        range_min_years: 2, range_max_years: 3, statute: LIMIT_ACT, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n4", record_type: "Backup media holding records",
        range_min_years: 1, range_max_years: 2, statute: TRUSTEE_ACT, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n5", record_type: "Shredding certificates",
        range_min_years: 2, range_max_years: 3, statute: LIMIT_ACT, as_of: AS_OF,
      },
    },
    { intent: "run_check", params: { checks: ["connectivity", "retention_cited"] } },
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
  for (const k of [5, 6, 7, 8]) recorder.rec(it[k].intent, it[k].params);
  for (const k of [9, 10, 11, 12, 13]) recorder.rec(it[k].intent, it[k].params);
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
