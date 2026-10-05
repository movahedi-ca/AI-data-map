#!/usr/bin/env node
/* pilot/run-canvas.mjs - canvas half of the Phase 4 teacher pilot.
 *
 * Starts the canvas static server (serve-canvas.mjs, a disposable copy of
 * the repo web/ dir) and the localhost-qa MCP client, runs the canvas
 * scenarios (canvas-view-session, canvas-keyboard-build, canvas-zoom-preserve)
 * with a full ctx, validates every snapshot in their shards, replays each
 * shard, and writes pilot/report-canvas.json. Exits non-zero on any failure.
 *
 * Usage: node teacher/pilot/run-canvas.mjs [outDir]
 *   outDir defaults to the pilot dir; the full run uses teacher/shards-full.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const teacherDir = join(here, "..");
const libDir = join(teacherDir, "lib");
const scenariosDir = join(teacherDir, "scenarios");
const specsDir = join(teacherDir, "..", "specs");
const outDir = process.argv[2] || process.env.CANVAS_OUT_DIR || here;

const { validateSnapshot } = await import(pathToFileURL(join(libDir, "validate.mjs")).href);
const { replay } = await import(pathToFileURL(join(libDir, "replay.mjs")).href);
const serve = await import(pathToFileURL(join(teacherDir, "driver", "serve-canvas.mjs")).href);
const mcp = await import(pathToFileURL(join(teacherDir, "driver", "mcp-client.mjs")).href);

const SCENARIOS = ["canvas-view-session.mjs", "canvas-keyboard-build.mjs", "canvas-zoom-preserve.mjs"];

const results = [];
let failed = 0;
let server = null;
let client = null;

try {
  server = await serve.start();
  console.log("canvas demo serving at " + server.base);
  client = await mcp.start();
  console.log("mcp client started");

  for (const file of SCENARIOS) {
    const mod = await import(pathToFileURL(join(scenariosDir, file)).href);
    const ctx = { client, base: server.base, specsDir, libDir, outDir };
    let res = null;
    let error = null;
    try {
      res = await mod.run(ctx);
    } catch (e) {
      error = e;
    }
    if (error || !res || !res.jsonlPath) {
      console.log("FAIL " + mod.name + " run error: " + (error ? error.message : "no result"));
      results.push({ name: mod.name, domain: mod.domain, steps: 0, snapshots_valid: false, replay_ok: false });
      failed += 1;
      continue;
    }
    const lines = readFileSync(res.jsonlPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    const bad = [];
    for (const line of lines) {
      const record = JSON.parse(line);
      const v = validateSnapshot(record.snapshot_after, specsDir);
      if (!v.ok) bad.push({ step: record.step, errors: v.errors });
    }
    const rr = replay(res.jsonlPath, specsDir);
    const ok = bad.length === 0 && rr.ok;
    results.push({
      name: res.name || mod.name,
      domain: res.domain || mod.domain,
      steps: res.steps || lines.length,
      snapshots_valid: bad.length === 0,
      replay_ok: rr.ok,
    });
    console.log(
      (ok ? "PASS " : "FAIL ") + mod.name + " steps=" + lines.length +
      " snapshots=" + (bad.length === 0 ? "valid" : "INVALID") +
      " replay=" + (rr.ok ? "ok" : "MISMATCH")
    );
    if (!ok) failed += 1;
  }
} finally {
  try { if (client) await client.close(); } catch (_) {}
  try { if (server) await server.stop(); } catch (_) {}
}

const report = { generated_utc: new Date().toISOString(), scenarios: results };
writeFileSync(join(here, "report-canvas.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
console.log("report written: " + join(here, "report-canvas.json"));
console.log(failed === 0 ? "CANVAS PILOT PASS: " + results.length + " scenarios" : "CANVAS PILOT FAIL");
process.exitCode = failed === 0 ? 0 : 1;
