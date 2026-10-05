#!/usr/bin/env node
/* pilot/run-browser.mjs - browser half of the pilot.
 *
 * Starts the demo server and the localhost-qa MCP client, runs the
 * browser scenarios (import-basic, import-broken) with a full ctx,
 * validates every snapshot in their shards, replays each shard, and
 * writes pilot/report-browser.json. Exits non-zero on any failure.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const teacherDir = join(here, "..");
const libDir = join(teacherDir, "lib");
const scenariosDir = join(teacherDir, "scenarios");
const specsDir =
  process.env.HOME +
  "/workspace/goals/taiga-style-data-mapping-agent-on-movahedi-ca/hidden_files/phase4-early/repo/specs";
const outDir = here;
const templatePath = process.env.HOME + "/workspace/your_files/Data-Inventory-Template.xlsx";

const { validateSnapshot } = await import(pathToFileURL(join(libDir, "validate.mjs")).href);
const { replay } = await import(pathToFileURL(join(libDir, "replay.mjs")).href);
const serve = await import(pathToFileURL(join(teacherDir, "driver", "serve.mjs")).href);
const mcp = await import(pathToFileURL(join(teacherDir, "driver", "mcp-client.mjs")).href);

const results = [];
let failed = 0;
let server = null;
let client = null;

try {
  server = await serve.start();
  console.log("demo serving at " + server.base);
  client = await mcp.start();
  console.log("mcp client started");

  for (const file of ["import-basic.mjs", "import-broken.mjs"]) {
    const mod = await import(pathToFileURL(join(scenariosDir, file)).href);
    const ctx = { client, base: server.base, specsDir, libDir, outDir, templatePath };
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
writeFileSync(join(outDir, "report-browser.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
console.log("report written: " + join(outDir, "report-browser.json"));
console.log(failed === 0 ? "BROWSER PILOT PASS: " + results.length + " scenarios" : "BROWSER PILOT FAIL");
process.exitCode = failed === 0 ? 0 : 1;
