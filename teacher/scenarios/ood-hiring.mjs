/* scenarios/ood-hiring.mjs - out-of-domain teacher scenario: hiring pipeline.
 *
 * Same frozen grammar, different domain: collection is the application
 * inbox, systems are pipeline stages (phone screen, onsite loop, offer
 * desk), thirdparty is the background-check vendor, destruction is the
 * rejected pile. Scripted beats: 18 actions, including a flag_for_review
 * opened on a disputed onsite scorecard and cleared in-band with undo_last,
 * ranged retention citations on three nodes, a retention_cited plus
 * connectivity check, and a final export. Deterministic: fixed
 * coordinates, fixed labels, fixed as_of date, seeded RNG (mulberry32,
 * seed 11001) available but unused since every value is fixed.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "ood-hiring";
export const domain = "ood-hiring";

const AS_OF = "2026-09-15";
const STATUTE_LIMIT = "Limitation Act, 2002, S.O. 2002, c. 24, Sched. B, s. 5";
const STATUTE_TAX = "Income Tax Act, R.S.C., 1985, c. 1 (5th Supp.), s. 230(4)(b)";

// mulberry32, seed 11001. The scenario is fully scripted, so this is never
// called; the seed documents the deterministic tie-break order for any
// future layout variant of this plugin.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
void mulberry32;

const recipe = {
  name: "OOD: hiring pipeline map (inbox, screens, vendor, rejected pile)",
  recipe_id: "p4-ood-hiring-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 100, label: "Application inbox" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 80, label: "Phone screen" } },
    { intent: "add_node", params: { node_id: "n3", type: "system", x: 300, y: 200, label: "Onsite loop" } },
    { intent: "add_node", params: { node_id: "n4", type: "system", x: 300, y: 320, label: "Offer desk" } },
    { intent: "add_node", params: { node_id: "n5", type: "thirdparty", x: 540, y: 120, label: "Background-check vendor Verity" } },
    { intent: "add_node", params: { node_id: "n6", type: "destruction", x: 540, y: 300, label: "Rejected pile" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n3", cat: "contact" } },
    { intent: "connect", params: { a: "n3", b: "n4", cat: "contact" } },
    { intent: "connect", params: { a: "n4", b: "n5", cat: "contact" } },
    {
      intent: "set_retention",
      params: {
        node_id: "n2", record_type: "Interview scorecards",
        range_min_years: 2, range_max_years: 3, statute: STATUTE_LIMIT, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n3", record_type: "Interview scorecards",
        range_min_years: 2, range_max_years: 3, statute: STATUTE_LIMIT, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n5", record_type: "Vendor screening records",
        range_min_years: 6, range_max_years: 7, statute: STATUTE_TAX, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: { node_id: "n4", record_type: "Offer letter log", verify_only: true, as_of: AS_OF },
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
  for (const k of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) recorder.rec(it[k].intent, it[k].params);
  // Disputed scorecard: flag the onsite loop node for review, then clear
  // the flag in-band with undo_last and continue the recipe.
  recorder.rec("flag_for_review", {
    node_id: "n3",
    reason: "Scorecard dispute: two interviewers disagreed on the onsite panel rating.",
  });
  recorder.rec("undo_last", {});
  for (const k of [10, 11, 12, 13, 14, 15]) recorder.rec(it[k].intent, it[k].params);
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
