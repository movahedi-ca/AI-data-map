/* scenarios/ood-incident.mjs - out-of-domain teacher scenario: security incident triage.
 *
 * Same frozen grammar, different domain: collection is the SIEM intake,
 * systems are affected servers, thirdparty is the forensics vendor,
 * destruction is the quarantined-host bin. Scripted beats: 16 actions,
 * including a flag_for_review opened on an uncertain blast radius and
 * cleared in-band with undo_last, a verify_only retention citation on the
 * SIEM node, and a retention_cited check over the cited systems.
 * Deterministic: fixed coordinates, fixed labels, fixed as_of date.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "ood-incident";
export const domain = "ood-incident-response";

const AS_OF = "2026-09-15";
const STATUTE = "Limitation Act, 2002, S.O. 2002, c. 24, Sched. B, s. 5";

const recipe = {
  name: "Pilot OOD: security incident triage map (SIEM, servers, forensics, quarantine)",
  recipe_id: "pilot-ood-incident-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 100, label: "SIEM intake queue" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 80, label: "Mail server EXCH-01" } },
    { intent: "add_node", params: { node_id: "n3", type: "system", x: 300, y: 200, label: "File server FS-02" } },
    { intent: "add_node", params: { node_id: "n4", type: "thirdparty", x: 540, y: 120, label: "Forensics vendor Halden" } },
    { intent: "add_node", params: { node_id: "n5", type: "destruction", x: 540, y: 300, label: "Quarantine bin QA-1" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n3", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n4", cat: "marketing" } },
    {
      intent: "set_retention",
      params: { node_id: "n1", record_type: "Incident logs", verify_only: true, as_of: AS_OF },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n2", record_type: "Incident response records",
        range_min_years: 2, range_max_years: 3, statute: STATUTE, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n3", record_type: "Incident response records",
        range_min_years: 2, range_max_years: 3, statute: STATUTE, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n4", record_type: "Incident response records",
        range_min_years: 2, range_max_years: 3, statute: STATUTE, as_of: AS_OF,
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
  // Uncertain blast radius: flag for review, then clear it in-band with undo_last.
  recorder.rec("flag_for_review", {
    reason: "Blast radius unclear: FS-02 shared drives may extend past the mail server.",
  });
  recorder.rec("undo_last", {});
  for (const k of [8, 9, 10, 11, 12, 13]) recorder.rec(it[k].intent, it[k].params);
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
