// replay.mjs
// Deterministic replay: rebuild an Executor from the shard manifest's
// embedded recipe, re-apply each recorded action in order, and compare
// the state hash at every step.

import { readFileSync } from "node:fs";
import { dirname, basename } from "node:path";
import { Executor } from "./executor.mjs";

// shardPath points at the <shard>.jsonl file; the manifest is the
// sibling <shard>.manifest.json. Returns {ok, steps, mismatches}.
export function replay(shardPath, specsDir) {
  const dir = dirname(shardPath);
  const base = basename(shardPath).replace(/\.jsonl$/, "");
  const manifest = JSON.parse(readFileSync(dir + "/" + base + ".manifest.json", "utf8"));
  const lines = readFileSync(shardPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const records = lines.map((l) => JSON.parse(l));
  if (records.length !== manifest.steps) {
    return {
      ok: false,
      steps: records.length,
      mismatches: [{ step: -1, expected: manifest.steps, got: records.length, note: "record count differs from manifest" }],
    };
  }
  const ex = new Executor(manifest.recipe, specsDir);
  const mismatches = [];
  for (const record of records) {
    const actionName = record.action.action_id.split(":")[0];
    let out;
    try {
      out = ex.apply(actionName, record.action.params);
    } catch (e) {
      mismatches.push({ step: record.step, expected: record.state_hash, got: null, note: "threw: " + e.message });
      continue;
    }
    if (out.action_record.state_hash !== record.state_hash) {
      mismatches.push({ step: record.step, expected: record.state_hash, got: out.action_record.state_hash });
    }
    if (out.action_record.action_id !== record.action.action_id) {
      mismatches.push({
        step: record.step,
        expected: record.action.action_id,
        got: out.action_record.action_id,
        note: "action_id drift",
      });
    }
  }
  return { ok: mismatches.length === 0, steps: records.length, mismatches };
}
