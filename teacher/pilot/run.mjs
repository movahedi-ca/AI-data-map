#!/usr/bin/env node
/* pilot/run.mjs - pilot orchestrator for the Phase 4 scripted-teacher harness.
 *
 * Discovers every scenarios/*.mjs module generically (a module counts when
 * it exports name, domain, and an async run(ctx)), runs each with a
 * deterministic ctx, validates every snapshot_after and snapshot_before in
 * each written shard, replays each shard, and writes pilot/report.json.
 * Prints PASS/FAIL per scenario and exits non-zero on any failure.
 *
 * The browser import scenarios (import-basic, import-broken) are picked up
 * by the same discovery with no code changes; they receive the same ctx
 * plus their own browser-provided fields from whoever invokes them.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const teacherDir = join(here, "..");
const scenariosDir = join(teacherDir, "scenarios");
const libDir = join(teacherDir, "lib");
const specsDir =
  process.env.HOME +
  "/workspace/goals/taiga-style-data-mapping-agent-on-movahedi-ca/hidden_files/phase4-early/repo/specs";
const outDir = here; // fixed pilot output dir
mkdirSync(outDir, { recursive: true });

// Optional argv filter: --only=PREFIX runs only scenarios whose name
// starts with PREFIX (e.g. --only=ood- for the headless pilot). Default:
// every discovered scenario.
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const onlyPrefix = onlyArg ? onlyArg.slice("--only=".length) : null;

const { validateSnapshot } = await import(pathToFileURL(join(libDir, "validate.mjs")).href);
const { replay } = await import(pathToFileURL(join(libDir, "replay.mjs")).href);

function discover() {
  const files = readdirSync(scenariosDir).filter((f) => f.endsWith(".mjs")).sort();
  return files.map((f) => join(scenariosDir, f));
}

async function loadScenario(path) {
  const mod = await import(pathToFileURL(path).href);
  if (typeof mod.run !== "function" || typeof mod.name !== "string" || typeof mod.domain !== "string") {
    return null; // not a runnable scenario (e.g. common.mjs helpers)
  }
  return mod;
}

function validateShard(jsonlPath) {
  const lines = readFileSync(jsonlPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const bad = [];
  for (const line of lines) {
    const record = JSON.parse(line);
    const after = validateSnapshot(record.snapshot_after, specsDir);
    if (!after.ok) bad.push({ step: record.step, which: "snapshot_after", errors: after.errors });
    if (record.snapshot_before) {
      const before = validateSnapshot(record.snapshot_before, specsDir);
      if (!before.ok) bad.push({ step: record.step, which: "snapshot_before", errors: before.errors });
    }
  }
  return { records: lines.length, ok: bad.length === 0, bad };
}

const results = [];
let failed = 0;

for (const path of discover()) {
  let mod = null;
  try {
    mod = await loadScenario(path);
  } catch (e) {
    console.log("FAIL <unloadable " + path + "> load error: " + e.message);
    failed += 1;
    continue;
  }
  if (!mod) continue;
  if (onlyPrefix && !mod.name.startsWith(onlyPrefix)) {
    console.log("SKIP " + mod.name + " (outside --only=" + onlyPrefix + ")");
    continue;
  }
  const ctx = { libDir, specsDir, outDir };
  let res = null;
  let error = null;
  try {
    res = await mod.run(ctx);
  } catch (e) {
    error = e;
  }
  if (error || !res || !res.jsonlPath) {
    console.log("FAIL " + mod.name + " (" + mod.domain + ") run error: " + (error ? error.message : "no result"));
    results.push({ name: mod.name, domain: mod.domain, steps: 0, snapshots_valid: false, replay_ok: false });
    failed += 1;
    continue;
  }
  const snapCheck = validateShard(res.jsonlPath);
  const replayRes = replay(res.jsonlPath, specsDir);
  const ok = snapCheck.ok && replayRes.ok;
  const steps = res.steps || 0;
  results.push({
    name: res.name || mod.name,
    domain: res.domain || mod.domain,
    steps,
    snapshots_valid: snapCheck.ok,
    replay_ok: replayRes.ok,
  });
  if (ok) {
    console.log("PASS " + mod.name + " (" + mod.domain + ") steps=" + steps + " snapshots=valid replay=ok");
  } else {
    failed += 1;
    console.log("FAIL " + mod.name + " (" + mod.domain + ") steps=" + steps);
    for (const b of snapCheck.bad) {
      console.log("  snapshot invalid step=" + b.step + " which=" + b.which + " errors=" + JSON.stringify(b.errors));
    }
    for (const m of replayRes.mismatches) {
      console.log("  replay mismatch " + JSON.stringify(m));
    }
  }
}

const report = {
  generated_utc: new Date().toISOString(),
  scenarios: results,
};
writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
console.log("report written: " + join(outDir, "report.json"));
console.log(failed === 0 ? "PILOT PASS: " + results.length + " scenarios" : "PILOT FAIL: " + failed + " scenario(s) failed");
process.exitCode = failed === 0 ? 0 : 1;
