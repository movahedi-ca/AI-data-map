/* scenarios/ood-adv-wrongnode.mjs - adversarial teacher scenario: wrong node, incident flavor.
 *
 * Corruption: recipe item 3 adds the thirdparty node n4 with the wrong
 * vendor name "Forensics vendor Halden"; the engagement is actually with
 * "Forensics vendor Sable". The teacher applies the item exactly, spots the
 * wrong vendor, and recovers.
 * Recovery (gold): undo_last deletes the wrong-vendor node, then the
 * corrected recipe item re-adds it as n5 (guide seq is monotonic, so the
 * undone n4 id stays a tombstoned gap; that gap is the deliberate undo
 * trace, per the catalogue "undone ids leave gaps").
 * Deterministic: fixed labels/coords/dates, as_of 2026-09-15.
 * RNG: mulberry32(20260915); coordinates are fixed literals, the seed
 * documents the (unused) stream.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "ood-adv-wrongnode";
export const domain = "ood-incident-response";

const AS_OF = "2026-09-15";
const LIMITATION = "Limitation Act, 2002, S.O. 2002, c. 24, Sched. B, s. 5";

const recipe = {
  name: "Adversarial: incident triage map with the wrong forensics vendor, undone and re-added",
  recipe_id: "p4-ood-adv-wrongnode-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 100, label: "SIEM intake queue" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 80, label: "Mail server EXCH-01" } },
    { intent: "add_node", params: { node_id: "n3", type: "system", x: 300, y: 200, label: "File server FS-02" } },
    { intent: "add_node", params: { node_id: "n4", type: "thirdparty", x: 540, y: 120, label: "Forensics vendor Halden" } },
    { intent: "add_node", params: { node_id: "n5", type: "thirdparty", x: 540, y: 120, label: "Forensics vendor Sable" } },
    { intent: "add_node", params: { node_id: "n6", type: "destruction", x: 540, y: 300, label: "Quarantine bin QA-1" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n3", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n5", cat: "marketing" } },
    {
      intent: "set_retention",
      params: { node_id: "n1", record_type: "Incident logs", verify_only: true, as_of: AS_OF },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n2", record_type: "Incident response records",
        range_min_years: 2, range_max_years: 3, statute: LIMITATION, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n3", record_type: "Incident response records",
        range_min_years: 2, range_max_years: 3, statute: LIMITATION, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n5", record_type: "Forensics engagement records",
        range_min_years: 2, range_max_years: 3, statute: LIMITATION, as_of: AS_OF,
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
  for (const k of [0, 1, 2, 3]) recorder.rec(it[k].intent, it[k].params);
  // Item 3 named the wrong forensics vendor (Halden instead of Sable).
  // Gold recovery: undo_last deletes the wrong node, then the corrected
  // item re-adds it under the next guide seq id.
  recorder.rec("undo_last", {});
  for (const k of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
    recorder.rec(it[k].intent, it[k].params);
  }
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
