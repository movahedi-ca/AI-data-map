#!/usr/bin/env node
/* run-headless.mjs - Phase 4 full-run headless scenario runner.
 *
 * Discovers teacher/scenarios/*.mjs, runs every scenario whose run(ctx)
 * works headless (skips the browser scenarios: import-*, canvas-*), into
 * the outDir given as argv[1]. Validates every snapshot and replays every
 * shard. Used for the determinism double-run: run twice into two dirs,
 * convert both, sha256-compare the converted shards.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const teacherDir = join(here, "..");
const scenariosDir = join(teacherDir, "scenarios");
const libDir = join(teacherDir, "lib");
const specsDir = join(teacherDir, "..", "specs");
const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node run-headless.mjs <outDir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const SKIP = new Set(["import-basic", "import-broken", "canvas-view-session", "canvas-keyboard-build", "canvas-zoom-preserve"]);

const { validateSnapshot } = await import(pathToFileURL(join(libDir, "validate.mjs")).href);
const { replay } = await import(pathToFileURL(join(libDir, "replay.mjs")).href);

const files = readdirSync(scenariosDir).filter((f) => f.endsWith(".mjs")).sort();
let failed = 0;
const results = [];
for (const f of files) {
  const mod = await import(pathToFileURL(join(scenariosDir, f)).href);
  if (typeof mod.run !== "function" || typeof mod.name !== "string") continue;
  if (SKIP.has(mod.name)) {
    console.log("SKIP " + mod.name + " (browser scenario)");
    continue;
  }
  const ctx = { libDir, specsDir, outDir };
  let res = null;
  try {
    res = await mod.run(ctx);
  } catch (e) {
    console.log("FAIL " + mod.name + " run error: " + e.message);
    failed += 1;
    continue;
  }
  const lines = readFileSync(res.jsonlPath, "utf8").split("\n").filter((l) => l.trim());
  const bad = [];
  for (const line of lines) {
    const r = JSON.parse(line);
    const v = validateSnapshot(r.snapshot_after, specsDir);
    if (!v.ok) bad.push({ step: r.step, errors: v.errors });
  }
  const rr = replay(res.jsonlPath, specsDir);
  const ok = bad.length === 0 && rr.ok;
  results.push({ name: mod.name, steps: lines.length, ok });
  console.log((ok ? "PASS " : "FAIL ") + mod.name + " steps=" + lines.length);
  if (!ok) failed += 1;
}
writeFileSync(join(outDir, "report-headless.json"), JSON.stringify({ results }, null, 2) + "\n");
console.log(failed === 0 ? "HEADLESS PASS: " + results.length + " scenarios" : "HEADLESS FAIL: " + failed);
process.exitCode = failed === 0 ? 0 : 1;
