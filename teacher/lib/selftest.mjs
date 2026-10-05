// selftest.mjs
// End-to-end checks for the Phase 4 scripted-teacher core library.
// Prints PASS/FAIL per check and exits non-zero on any failure.

import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Executor, sha256hex, checkStatute } from "./executor.mjs";
import { Recorder } from "./recorder.mjs";
import { validateSnapshot, validateRecipe } from "./validate.mjs";
import { replay } from "./replay.mjs";

const SPECS = process.env.SPECS_DIR ||
  join(process.env.HOME, "workspace/goals/taiga-style-data-mapping-agent-on-movahedi-ca/hidden_files/phase4-early/repo/specs");
const H0 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("PASS " + name);
  } else {
    failures += 1;
    console.log("FAIL " + name + (detail ? ": " + detail : ""));
  }
}
function expectThrow(name, fn, needle) {
  try {
    fn();
  } catch (e) {
    check(name + " throws", !needle || e.message.includes(needle), "wrong message: " + e.message);
    return e.message;
  }
  check(name + " throws", false, "no error raised");
  return null;
}
function snapOk(name, snap) {
  const v = validateSnapshot(snap, SPECS);
  check(name + " snapshot validates", v.ok, JSON.stringify(v.errors).slice(0, 300));
}

const sample = JSON.parse(readFileSync(join(SPECS, "SAMPLE-RECIPE.json"), "utf8"));

// ---------- scenario 1: SAMPLE-RECIPE end to end ----------
{
  const vr = validateRecipe(sample, SPECS);
  check("sample recipe validates", vr.ok, JSON.stringify(vr.errors).slice(0, 300));

  const ex = new Executor(sample, SPECS);
  const s0 = ex.snapshot();
  check("initial snapshot_version", s0.snapshot_version === "1.0.0");
  check("initial canvas empty", JSON.stringify(s0.canvas) === JSON.stringify({ nodes: {}, edges: [] }));
  check("initial annotations empty", s0.annotations.length === 0);
  check("initial applied_keys empty", Object.keys(s0.applied_keys).length === 0);
  check("initial actions empty", s0.actions.length === 0);
  check("initial dropped_prefix", s0.dropped_prefix.count === 0 && s0.dropped_prefix.prefix_hash === H0);
  check("initial terminated/abort", s0.terminated === false && s0.abort_reason === null);
  snapOk("scenario1 initial", s0);

  const rec = new Recorder({ executor: ex, shard: "sample-01", domain: "privacy-mapping", recipe: sample });
  const menu0 = ex.validMenu();
  check("menu has 4 entries at start (no undo_last yet)", menu0.length === 4, JSON.stringify(menu0.map((m) => m.action_name)));
  check("menu alphabetical", JSON.stringify(menu0.map((m) => m.action_name)) ===
    JSON.stringify(["abort_session", "add_collection_point", "flag_for_review", "skip_recipe_item"]));
  check("menu carries exact recipe params",
    JSON.stringify(menu0.find((m) => m.action_name === "add_collection_point").params) ===
    JSON.stringify(sample.items[0].params));

  for (let i = 0; i < sample.items.length; i++) {
    const menu = ex.validMenu();
    const entry = menu.find((m) => m.action_name === sample.items[i].intent);
    check(`item ${i} intent in menu`, !!entry, sample.items[i].intent);
    const r = rec.rec(entry.action_name, entry.params);
    check(`item ${i} action_id`, r.action.action_id === `${sample.items[i].intent}:${i}`, r.action.action_id);
    check(`item ${i} state_hash shape`, /^[0-9a-f]{64}$/.test(r.state_hash));
    snapOk(`scenario1 item ${i}`, r.snapshot_after);
  }
  check("recipe advanced past last item", ex.snapshot().item_index === sample.items.length);

  // The run_check report: retention_cited must fail because n3 (thirdparty)
  // has no retention annotation, while the other checks pass.
  const runCheckEntry = Object.values(ex.snapshot().applied_keys)
    .find((v) => v.action_record.action_id === "run_check:6");
  check("run_check recorded", !!runCheckEntry);
  const report = runCheckEntry.result.report;
  check("run_check report has all checks", ["label_coverage", "connectivity", "retention_cited", "edge_categories"]
    .every((c) => report[c] && typeof report[c].pass === "boolean"));
  check("run_check retention_cited fails on n3", report.retention_cited.pass === false &&
    report.retention_cited.findings.some((f) => f.includes("n3")));
  check("run_check edge_categories passes", report.edge_categories.pass === true);

  const dir = mkdtempSync(join(tmpdir(), "teacher-shard-"));
  const { jsonlPath, manifestPath } = rec.writeShard(dir);
  check("shard files written", !!jsonlPath && !!manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  check("manifest self-contained", manifest.recipe.recipe_id === sample.recipe_id &&
    manifest.steps === sample.items.length &&
    /^[0-9a-f]{64}$/.test(manifest.first_state_hash) &&
    manifest.last_state_hash === rec.records[rec.records.length - 1].state_hash);
  check("record 0 carries snapshot_before", !!rec.records[0].snapshot_before &&
    rec.records[0].snapshot_before.canvas.nodes && Object.keys(rec.records[0].snapshot_before.canvas.nodes).length === 0);

  const rp = replay(jsonlPath, SPECS);
  check("replay sample shard ok", rp.ok && rp.steps === sample.items.length, JSON.stringify(rp.mismatches).slice(0, 300));
}

// ---------- idempotency: replay returns recorded result, no work ----------
// Keys bind (recipe_id, item_index, action). Intent completion advances
// the item, so replay matters for non-advancing actions: undo_last and
// flag_for_review keep item_index put, and a repeated call must be a
// clean no-op returning the recorded result.
{
  const ex = new Executor(sample, SPECS);
  ex.apply("add_collection_point", sample.items[0].params);
  const u1 = ex.apply("undo_last", {});
  const before = JSON.stringify(ex.snapshot().canvas);
  const u2 = ex.apply("undo_last", {});
  check("undo replay returns recorded action_id", u2.action_record.action_id === u1.action_record.action_id);
  check("undo replay does no work", JSON.stringify(ex.snapshot().canvas) === before);
  check("undo replay keeps one undo record", ex.snapshot().actions.filter((a) => a.action_id.startsWith("undo_last")).length === 1);

  const ex2 = new Executor(sample, SPECS);
  ex2.apply("add_collection_point", sample.items[0].params);
  ex2.apply("flag_for_review", { reason: "first flag" });
  ex2.apply("flag_for_review", { reason: "first flag" });
  check("flag replay creates no second flag",
    ex2.snapshot().annotations.filter((a) => a.kind === "review_flag").length === 1);

  const r = { schema_version: "1.0.0", recipe_id: "undo-empty-01", items: [{ intent: "undo_last", params: {} }] };
  const ex3 = new Executor(r, SPECS);
  expectThrow("undo with nothing applied", () => ex3.apply("undo_last", {}), "no applied mutating action");
}

// ---------- undo: seq stays monotonic, ids leave gaps ----------
// Recipe item 1 re-uses node_id n1 with identical params; after item 0 is
// undone the guide seq is still 1, so n1 no longer matches the live seq.
{
  const n1 = { label: "Form", node_id: "n1", x: 80, y: 80 };
  const recipe = {
    schema_version: "1.0.0",
    recipe_id: "seq-gap-test-01",
    items: [
      { intent: "add_collection_point", params: n1 },
      { intent: "add_collection_point", params: { ...n1 } },
    ],
  };
  const ex = new Executor(recipe, SPECS);
  ex.apply("add_collection_point", n1);
  ex.apply("undo_last", {});
  check("undo removes the node", Object.keys(ex.snapshot().canvas.nodes).length === 0);
  expectThrow("re-add n1 after undo", () => ex.apply("add_collection_point", { ...n1 }), "out of sequence");
}

// ---------- tombstone: stale replay of an undone key is rejected ----------
// A flag raised as a recovery action does not advance item_index, so
// re-sending the same flag call after it was undone reuses its key.
{
  const recipe = {
    schema_version: "1.0.0",
    recipe_id: "tombstone-test-01",
    items: [
      { intent: "add_collection_point", params: { label: "Form", node_id: "n1", x: 80, y: 80 } },
      { intent: "export", params: { format: "xls" } },
    ],
  };
  const ex = new Executor(recipe, SPECS);
  ex.apply("add_collection_point", recipe.items[0].params);
  ex.apply("flag_for_review", { reason: "check this" });
  ex.apply("undo_last", {});
  check("flag cleared by undo", !ex.snapshot().annotations.some((a) => a.kind === "review_flag"));
  expectThrow("stale replay of undone flag key", () => ex.apply("flag_for_review", { reason: "check this" }), "tombstoned");
}

// ---------- set_retention: statute matcher (unit) ----------
// The recipe schema enforces the statute pattern at load, so the runtime
// matcher is defense in depth; test it directly.
{
  check("matcher accepts act+section", checkStatute("Loi sur l'administration fiscale, RLRQ, c. A-6.002, ss. 34, 35.3") === null);
  check("matcher accepts s. form", checkStatute("Income Tax Act, s. 230(4)(b)") === null);
  const law25 = checkStatute("Loi 25, art. 23");
  check("matcher rejects Law 25 variant", typeof law25 === "string" && law25.includes("sets no retention periods"), law25);
  const lprpsp = checkStatute("LPRPSP guidance, s. 8");
  check("matcher rejects LPRPSP", typeof lprpsp === "string" && lprpsp.includes("sets no retention periods"), lprpsp);
  const bare = checkStatute("Tax Administration Act");
  check("matcher rejects bare act name", typeof bare === "string" && bare.includes("no section"), bare);
  const short = checkStatute("s. 34");
  check("matcher rejects short statute", typeof short === "string", short);
}

// ---------- set_retention: runtime range and as_of checks ----------
// The schema allows equal bounds and future dates; the executor must not.
{
  const mk = (retentionParams) => {
    const recipe = {
      schema_version: "1.0.0",
      recipe_id: "retention-runtime-01",
      items: [
        { intent: "add_collection_point", params: { label: "Form", node_id: "n1", x: 80, y: 80 } },
        { intent: "add_node", params: { label: "CRM", node_id: "n2", type: "system", x: 300, y: 80 } },
        { intent: "set_retention", params: retentionParams },
      ],
    };
    const ex = new Executor(recipe, SPECS);
    ex.apply("add_collection_point", recipe.items[0].params);
    ex.apply("add_node", recipe.items[1].params);
    return { ex, recipe };
  };
  const base = { node_id: "n2", record_type: "Tax records", as_of: "2026-10-04", statute: "Tax Act, s. 34" };
  {
    const { ex, recipe } = mk({ ...base, range_min_years: 7, range_max_years: 7 });
    expectThrow("single number range rejected", () => ex.apply("set_retention", recipe.items[2].params), "strictly less than");
  }
  {
    const { ex, recipe } = mk({ ...base, range_min_years: 6, range_max_years: 7, as_of: "2099-01-01" });
    expectThrow("future as_of rejected", () => ex.apply("set_retention", recipe.items[2].params), "in the future");
  }
  {
    const { ex, recipe } = mk({ ...base, range_min_years: 6, range_max_years: 7 });
    const out = ex.apply("set_retention", recipe.items[2].params);
    check("valid retention accepted", /^[0-9a-f]{64}$/.test(out.action_record.state_hash));
    snapOk("retention", ex.snapshot());
  }
  {
    const { ex, recipe } = mk({ node_id: "n2", record_type: "Unknown", as_of: "2026-10-04", verify_only: true });
    const out = ex.apply("set_retention", recipe.items[2].params);
    check("verify_only accepted without statute", /^[0-9a-f]{64}$/.test(out.action_record.state_hash));
  }
}

// ---------- actions window truncation and prefix hash chain ----------
{
  const items = [{ intent: "add_collection_point", params: { label: "Form", node_id: "n1", x: 80, y: 80 } }];
  for (let i = 0; i < 40; i++) {
    items.push({ intent: "set_field", params: { node_id: "n1", field: "label", value: "Form v" + i } });
  }
  items.push({ intent: "export", params: { format: "xls" } });
  const recipe = { schema_version: "1.0.0", recipe_id: "truncation-test-01", items };
  const ex = new Executor(recipe, SPECS);
  const hashes = [];
  for (const item of items) {
    const entry = ex.validMenu().find((m) => m.action_name === item.intent);
    hashes.push(ex.apply(entry.action_name, entry.params).action_record.state_hash);
  }
  const snap = ex.snapshot();
  check("window keeps 32 records", snap.actions.length === 32);
  check("dropped count", snap.dropped_prefix.count === items.length - 32, String(snap.dropped_prefix.count));
  let h = H0;
  for (let i = 0; i < snap.dropped_prefix.count; i++) h = sha256hex(h + hashes[i]);
  check("prefix hash chain matches", snap.dropped_prefix.prefix_hash === h);
  check("window starts after dropped prefix", snap.actions[0].state_hash === hashes[snap.dropped_prefix.count]);
  snapOk("truncation", snap);
}

// ---------- scenario 2: undo, flag open/clear, skip, abort ----------
{
  const recipe = {
    schema_version: "1.0.0",
    recipe_id: "recovery-test-01",
    name: "recovery path test",
    items: [
      { intent: "add_collection_point", params: { label: "Form", node_id: "n1", x: 80, y: 80 } },
      { intent: "add_node", params: { label: "CRM", node_id: "n2", type: "system", x: 300, y: 80 } },
      { intent: "connect", params: { a: "n1", b: "n2", cat: "contact" } },
      { intent: "export", params: { format: "xls" } },
    ],
  };
  const ex = new Executor(recipe, SPECS);
  const rec = new Recorder({ executor: ex, shard: "recovery-01", domain: "privacy-mapping", recipe });
  const intentParams = () => ex.validMenu().find((m) => m.action_name === recipe.items[ex.snapshot().item_index].intent).params;

  rec.rec("add_collection_point", intentParams());
  check("after item 0 item_index is 1", ex.snapshot().item_index === 1);

  rec.rec("flag_for_review", { reason: "The CRM label looks wrong, please confirm." });
  check("flag opens", ex.snapshot().annotations.some((a) => a.kind === "review_flag"));
  const gatedMenu = ex.validMenu().map((m) => m.action_name);
  check("flag gating reduces menu", JSON.stringify(gatedMenu) ===
    JSON.stringify(["abort_session", "flag_for_review", "undo_last"]));
  expectThrow("intent blocked while flag open", () => ex.apply("add_node", recipe.items[1].params), "not in the valid-action menu");
  expectThrow("skip blocked while flag open", () => ex.apply("skip_recipe_item", { item_index: 1, reason: "x" }), "not in the valid-action menu");

  const undoRec = rec.rec("undo_last", {});
  check("undo clears the flag", !ex.snapshot().annotations.some((a) => a.kind === "review_flag"));
  check("undo record action_id", undoRec.action.action_id === "undo_last:1", undoRec.action.action_id);
  check("item_index frozen through flag+undo", ex.snapshot().item_index === 1);
  check("menu restored after clear", ex.validMenu().some((m) => m.action_name === "add_node"));

  rec.rec("add_node", intentParams());
  rec.rec("skip_recipe_item", { item_index: 2, reason: "Connection already documented elsewhere." });
  check("skip advances past item 2", ex.snapshot().item_index === 3);
  expectThrow("skip wrong index", () => ex.apply("skip_recipe_item", { item_index: 9, reason: "nope" }), "must equal the current item_index");

  rec.rec("export", intentParams());
  rec.rec("abort_session", { reason: "Test session ends here." });
  const term = ex.snapshot();
  check("terminated sealed", term.terminated === true && term.abort_reason === "Test session ends here.");
  snapOk("scenario2 terminal", term);
  expectThrow("fresh action after abort", () => ex.apply("export", { format: "xls" }), "terminated");
  // Replaying the abort key is a clean no-op: the session stays terminated.
  const abortAgain = ex.apply("abort_session", { reason: "Test session ends here." });
  check("abort replay no-op", abortAgain.snapshot.terminated === true);

  for (const r of rec.records) snapOk(`scenario2 step ${r.step}`, r.snapshot_after);
  const dir = mkdtempSync(join(tmpdir(), "teacher-shard-"));
  const { jsonlPath } = rec.writeShard(dir);
  const rp = replay(jsonlPath, SPECS);
  check("replay recovery shard ok", rp.ok && rp.steps === rec.records.length, JSON.stringify(rp.mismatches).slice(0, 300));
}

// ---------- recipe load rejections ----------
{
  expectThrow("bad recipe rejected", () => new Executor({ schema_version: "1.0.0", recipe_id: "x", items: [] }, SPECS), "invalid recipe");
  expectThrow("unsupported version rejected", () =>
    new Executor({ schema_version: "2.0.0", recipe_id: "x", items: [{ intent: "export", params: { format: "xls" } }] }, SPECS),
    "recipe load rejected");
  expectThrow("unknown intent rejected", () =>
    new Executor({ schema_version: "1.0.0", recipe_id: "x", items: [{ intent: "teleport", params: {} }] }, SPECS),
    "invalid recipe");
}

console.log(failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
