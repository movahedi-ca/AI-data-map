/* scenarios/ood-conference.mjs - out-of-domain teacher scenario: conference planning.
 *
 * The frozen grammar is reused for a different domain: collection nodes are
 * registration desks, system is the venue AV/registration system, thirdparty
 * is the catering vendor, destruction is a badge shred bin. Edges keep the
 * frozen categories (contact/payment/marketing) as flow categories.
 *
 * Scripted beats: 15 actions. Five nodes, one misplaced node undone and
 * re-added correctly (the guide seq stays monotonic, so the re-add is n6),
 * a label rename, a confirmation, label and connectivity checks, export.
 * Deterministic: fixed coordinates, fixed labels, no clock or random input.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "ood-conference";
export const domain = "ood-conference-planning";

const recipe = {
  name: "Pilot OOD: conference planning map (desks, AV, catering, shred bin)",
  recipe_id: "pilot-ood-conference-01",
  schema_version: "1.0.0",
  items: [
    { intent: "add_collection_point", params: { node_id: "n1", x: 80, y: 90, label: "Main registration desk" } },
    { intent: "add_node", params: { node_id: "n2", type: "system", x: 320, y: 80, label: "Venue AV control booth" } },
    { intent: "add_node", params: { node_id: "n3", type: "thirdparty", x: 520, y: 140, label: "Catering vendor" } },
    { intent: "add_node", params: { node_id: "n4", type: "destruction", x: 520, y: 300, label: "Badge shred bin" } },
    // Misplaced: the satellite desk lands next to the shred bin, wrong lobby.
    { intent: "add_node", params: { node_id: "n5", type: "collection", x: 580, y: 350, label: "Satellite desk" } },
    // Re-added correctly after the undo. The seq is monotonic, so this is n6.
    { intent: "add_node", params: { node_id: "n6", type: "collection", x: 110, y: 300, label: "Satellite check-in desk" } },
    { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n1", b: "n3", cat: "payment" } },
    { intent: "connect", params: { a: "n6", b: "n2", cat: "contact" } },
    { intent: "connect", params: { a: "n2", b: "n3", cat: "marketing" } },
    { intent: "set_field", params: { node_id: "n4", field: "label", value: "Badge shred bin (lobby)" } },
    { intent: "confirm_node", params: { node_id: "n1", note: "Registration desk placement confirmed with venue map." } },
    { intent: "run_check", params: { checks: ["label_coverage", "connectivity"] } },
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
  recorder.rec(it[4].intent, it[4].params); // misplaced n5
  recorder.rec("undo_last", {});           // remove the misplaced node
  recorder.rec(it[5].intent, it[5].params); // re-add correctly as n6
  for (const k of [6, 7, 8, 9]) recorder.rec(it[k].intent, it[k].params);
  recorder.rec(it[10].intent, it[10].params); // rename the shred bin
  recorder.rec(it[11].intent, it[11].params); // confirm the main desk
  recorder.rec(it[12].intent, it[12].params); // label + connectivity checks
  recorder.rec(it[13].intent, it[13].params); // export
  const { jsonlPath, manifestPath } = recorder.writeShard(outDir);
  console.log("[" + name + "] " + recorder.records.length + " records -> " + jsonlPath);
  return { name, domain, steps: recorder.records.length, jsonlPath, manifestPath };
}
