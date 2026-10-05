// recorder.mjs
// Scripted-teacher recorder: drives an Executor through a fixed action
// sequence and writes a self-contained shard (jsonl + manifest) that
// replay.mjs can re-execute byte-deterministically.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export class Recorder {
  constructor({ executor, shard, domain, recipe }) {
    if (!executor) throw new Error("Recorder needs an executor.");
    if (!shard) throw new Error("Recorder needs a shard name.");
    this._ex = executor;
    this._shard = shard;
    this._domain = domain || "unknown";
    this._recipe = JSON.parse(JSON.stringify(recipe));
    this._records = [];
    this._snapshotBefore = null;
    this._initialHash = null;
  }

  // Applies one action through the executor and appends the record.
  rec(actionName, params) {
    const step = this._records.length;
    if (step === 0) {
      this._snapshotBefore = this._ex.snapshot();
      this._initialHash = this._ex.stateHash();
    }
    const menuBefore = this._ex.validMenu();
    const { action_record } = this._ex.apply(actionName, params);
    const record = {
      step,
      menu_before: menuBefore,
      action: { action_id: action_record.action_id, params: action_record.params },
      state_hash: action_record.state_hash,
      snapshot_after: this._ex.snapshot(),
    };
    if (step === 0) {
      record.snapshot_before = this._snapshotBefore;
    }
    this._records.push(record);
    return record;
  }

  // Writes <shard>.jsonl (one record per line) and <shard>.manifest.json
  // into dir. The manifest carries the full recipe so replay is
  // self-contained.
  writeShard(dir) {
    mkdirSync(dir, { recursive: true });
    const jsonlPath = join(dir, this._shard + ".jsonl");
    const manifestPath = join(dir, this._shard + ".manifest.json");
    writeFileSync(jsonlPath, this._records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    const manifest = {
      shard: this._shard,
      domain: this._domain,
      recipe_id: this._recipe.recipe_id,
      recipe: this._recipe,
      steps: this._records.length,
      first_state_hash: this._initialHash,
      last_state_hash: this._records.length > 0 ? this._records[this._records.length - 1].state_hash : null,
      created_utc: new Date().toISOString(),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    return { jsonlPath, manifestPath };
  }

  get records() {
    return this._records;
  }
}
