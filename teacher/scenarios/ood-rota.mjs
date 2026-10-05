/* scenarios/ood-rota.mjs - out-of-domain teacher scenario: volunteer rota.
 *
 * Same frozen grammar, different domain: collection is the signup form,
 * systems are the Saturday and Sunday shifts, thirdparty is the partner
 * charity, destruction is the dropout bin. Scripted beats: 17 actions,
 * including a confirm_node on the signup form, a ranged retention citation
 * on the signup form, a verify_only citation on the Saturday shift, a
 * retention_cited plus label_coverage check, and a final export.
 * Deterministic: fixed coordinates, fixed labels, fixed as_of date,
 * seeded RNG (mulberry32, seed 55005) available but unused since every
 * value is fixed.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "ood-rota";
export const domain = "ood-rota";

const AS_OF = "2026-09-15";
const STATUTE_LIMIT = "Limitation Act, 2002, S.O. 2002, c. 24, Sched. B, s. 5";

// mulberry32, seed 55005. The scenario is fully scripted, so this is never
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
  name: "OOD: volunteer rota map (signup, shifts, partner charity, dropout bin)",
  recipe_id: "p4-ood-rota-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 70, y: 100, label: "Signup form" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 300, y: 90, label: "Saturday shift" } },
    { intent: "add_node", params: { node_id: "n3", type: "system", x: 300, y: 220, label: "Sunday shift" } },
    { intent: "add_node", params: { node_id: "n4", type: "thirdparty", x: 540, y: 140, label: "Partner charity Brightpath" } },
    { intent: "add_node", params: { node_id: "n5", type: "destruction", x: 540, y: 300, label: "Dropout bin" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n1", b: "n3", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n4", cat: "contact" } },
    { intent: "connect", params: { a: "n3", b: "n4", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n5", cat: "contact" } },
    {
      intent: "confirm_node",
      params: { node_id: "n1", note: "Signup fields confirmed with the volunteer coordinator." },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n1", record_type: "Volunteer signup records",
        range_min_years: 2, range_max_years: 3, statute: STATUTE_LIMIT, as_of: AS_OF,
      },
    },
    {
      intent: "set_retention",
      params: { node_id: "n2", record_type: "Shift attendance log", verify_only: true, as_of: AS_OF },
    },
    {
      intent: "set_retention",
      params: { node_id: "n3", record_type: "Sunday shift attendance log", verify_only: true, as_of: AS_OF },
    },
    {
      intent: "set_retention",
      params: {
        node_id: "n4", record_type: "Charity partnership records",
        range_min_years: 2, range_max_years: 3, statute: STATUTE_LIMIT, as_of: AS_OF,
      },
    },
    { intent: "run_check", params: { checks: ["retention_cited", "label_coverage"] } },
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
  for (let k = 0; k < it.length; k++) recorder.rec(it[k].intent, it[k].params);
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
