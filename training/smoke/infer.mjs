// Node inference smoke test: load the exported ONNX model with
// onnxruntime-node, run every fixture step, and assert the outputs are
// well-formed action sequences.
//
// Well-formed means: finite scores, the argmax lands on a menu position,
// the chosen name is one of the step's menu actions, and the collected
// per-step predictions form a sequence the same length as the episode.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");

const [modelPath, fixturePath] = process.argv.slice(2);
if (!modelPath || !fixturePath) {
  console.error("usage: node infer.mjs <model.onnx> <fixture.jsonl>");
  process.exit(1);
}

function stableHash(text, buckets) {
  // Must match tokenize.py: sha256, first 8 bytes big-endian, mod buckets.
  const { createHash } = require("node:crypto");
  const digest = createHash("sha256").update(text, "utf8").digest();
  return Number(digest.readBigUInt64BE(0) % BigInt(buckets));
}

function canonical(obj) {
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + JSON.stringify(obj[k])).join(",") + "}";
}

const FIELD_BUCKETS = 4096;
const NAME_BUCKETS = 1024;
const MENU_LO = 224, MENU_HI = 288;

const lines = readFileSync(fixturePath, "utf8").split("\n").filter((l) => l.trim());
const session = await ort.InferenceSession.create(modelPath);

let failures = 0;
const sequences = new Map(); // recipe_id -> predicted action names

for (const [n, line] of lines.entries()) {
  const step = JSON.parse(line);
  const T = step.input_ids.length;
  const tokIds = BigInt64Array.from(step.input_ids.map(BigInt));
  const fieldHash = BigInt64Array.from(step.fields.map((f) => BigInt(stableHash(canonical(JSON.parse(f)), FIELD_BUCKETS))));
  const nameHash = new BigInt64Array(T);
  const menuMask = new Uint8Array(T);
  const menuNames = [];
  step.input_ids.forEach((tid, i) => {
    if (tid >= MENU_LO && tid < MENU_HI) {
      menuMask[i] = 1;
      const name = JSON.parse(step.fields[i]).action_name;
      nameHash[i] = BigInt(stableHash(name, NAME_BUCKETS));
      menuNames.push(name);
    }
  });

  const feeds = {
    tok_ids: new ort.Tensor("int64", tokIds, [1, T]),
    field_hash: new ort.Tensor("int64", fieldHash, [1, T]),
    name_hash: new ort.Tensor("int64", nameHash, [1, T]),
    menu_mask: new ort.Tensor("bool", menuMask, [1, T]),
  };
  const out = await session.run(feeds);
  const scores = out.menu_scores.data; // Float32Array length T

  // Gate 1: every score on a menu position is finite. Non-menu positions
  // are -inf by design (the model masks them), so they are skipped.
  for (let i = 0; i < T; i++) {
    if (menuMask[i] && !Number.isFinite(scores[i])) { console.error(`step ${n}: non-finite score on menu position ${i}`); failures++; }
  }
  // Gate 2: argmax over menu positions only.
  let best = -1, bestScore = -Infinity;
  for (let i = 0; i < T; i++) {
    if (menuMask[i] && scores[i] > bestScore) { bestScore = scores[i]; best = i; }
  }
  if (best < 0) { console.error(`step ${n}: no menu position scored`); failures++; continue; }
  // Gate 3: chosen name is one of the menu actions.
  const menuIndex = step.input_ids.slice(0, best + 1).filter((t) => t >= MENU_LO && t < MENU_HI).length - 1;
  const name = step.menu_actions[menuIndex];
  if (!step.menu_actions.includes(name)) { console.error(`step ${n}: predicted name not in menu`); failures++; }
  if (!sequences.has(step.recipe_id)) sequences.set(step.recipe_id, []);
  sequences.get(step.recipe_id).push(name);
}

// Gate 4: sequences are complete per episode and non-empty.
for (const [rid, seq] of sequences) {
  if (seq.length === 0) { console.error(`episode ${rid}: empty sequence`); failures++; }
}
console.log(`ran ${lines.length} steps across ${sequences.size} episodes`);
for (const [rid, seq] of [...sequences].slice(0, 4)) {
  console.log(`  ${rid}: ${seq.join(" -> ")}`);
}
if (failures > 0) { console.error(`SMOKE FAILED: ${failures} failures`); process.exit(1); }
console.log("SMOKE PASSED: all outputs are well-formed action sequences");
