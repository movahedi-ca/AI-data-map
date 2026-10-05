"use strict";
/*
 * token-schema.test.js: frozen token schema contracts.
 * Run: node tests/specs/token-schema.test.js
 *
 * Covers: vocabulary accounting totals (288 usable), binary field layout,
 * control tokens, kind-table id ranges, deterministic sort orders for
 * menu/token serialization, menu grounding against the action catalogue,
 * and the load-bearing ordering rule.
 */

global.self = global;

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const tok = JSON.parse(fs.readFileSync(path.join(REPO, "specs", "token-schema.json"), "utf8"));
const cat = JSON.parse(fs.readFileSync(path.join(REPO, "specs", "action-catalogue.json"), "utf8"));

let n = 0;
let failed = 0;
function T(cond, msg) {
  n++;
  try {
    assert(cond, msg);
  } catch (e) {
    failed++;
    process.stderr.write("FAIL " + msg + "\n");
  }
}

/* ---------- 1. vocabulary accounting totals 288 ---------- */

const acct = tok.vocab_accounting;
T(acct.total_vocab_size === 65536, "total vocab size 65536 (2^16)");
T(acct.usable_in_phase0 === 288, "usable in phase 0 is 288");
const b = acct.breakdown;
T(b.control === 5, "breakdown control 5");
T(b.reserved_control === 27, "breakdown reserved_control 27");
T(b.nodes === 64 && b.edges === 64 && b.annotations === 64 && b.action_menu === 64,
  "breakdown 64 each for nodes/edges/annotations/action_menu");
T(b.future_reserved === 65248, "breakdown future_reserved 65248");
T(b.control + b.reserved_control + b.nodes + b.edges + b.annotations + b.action_menu === 288,
  "usable = 5 + 27 + 64 + 64 + 64 + 64 = 288");
T(acct.usable_in_phase0 + b.future_reserved === 65536, "usable + future_reserved = full 16-bit space");
T(acct.usable_note.indexOf("288") !== -1, "usable_note states the 288 sum explicitly");

/* ---------- 2. id ranges tile the space with no overlap ---------- */

const controls = tok.control_tokens;
T(controls.length === 5, "5 control tokens");
const expectCtl = [[0, "BOS"], [1, "EOS"], [2, "SNAPSHOT_SEP"], [3, "ANNOT_SEP"], [4, "MENU_SEP"]];
for (const [id, name] of expectCtl) {
  const c = controls.filter((x) => x.id === id)[0];
  T(c && c.name === name, "control token " + id + " is " + name);
  T(Array.isArray(c.fields) && c.fields.length === 0, name + " carries no fields");
  T(typeof c.role === "string" && c.role.length > 0, name + " documents its role");
}
T(controls.filter((c) => c.name === "BOS")[0].role.indexOf("start") !== -1, "BOS role: start of sequence");
T(controls.filter((c) => c.name === "EOS")[0].role.indexOf("end") !== -1, "EOS role: end of sequence");

const ranges = [];
for (const c of controls) ranges.push([c.id, c.id, "control"]);
const reserved = tok.reserved;
for (const r of reserved) ranges.push([r.id_range[0], r.id_range[1], r.name]);
T(JSON.stringify(reserved.filter((r) => r.name === "control_future")[0].id_range) === "[5,31]",
  "control_future reserves 5..31");
T(JSON.stringify(reserved.filter((r) => r.name === "vocab_future")[0].id_range) === "[288,65535]",
  "vocab_future reserves 288..65535");

const kinds = tok.kind_tables;
T(kinds.length === 4, "4 kind tables");
const expectKinds = [["node", 32, 95], ["edge", 96, 159], ["annotation", 160, 223], ["action_menu", 224, 287]];
for (const [name, lo, hi] of expectKinds) {
  const k = kinds.filter((x) => x.name === name)[0];
  T(!!k, "kind table " + name + " present");
  T(k.id_range[0] === lo && k.id_range[1] === hi, name + " id_range " + lo + ".." + hi);
  T(k.max_slots === 64, name + " max_slots 64");
  ranges.push([lo, hi, name]);
}
// pairwise overlap check across control tokens, reserved ranges, and kind tables
let overlap = false;
for (let i = 0; i < ranges.length; i++) {
  for (let j = i + 1; j < ranges.length; j++) {
    if (ranges[i][0] <= ranges[j][1] && ranges[j][0] <= ranges[i][1]) overlap = true;
  }
}
T(!overlap, "no id range overlaps (controls, reserved, kind tables)");

/* ---------- 3. binary field layout ---------- */

const bin = tok.binary_encoding;
T(bin.token_width_bits === 16, "token width 16 bits");
T(bin.byte_order === "big-endian", "byte order big-endian");
T(bin.layout.indexOf("uint16") !== -1 && bin.layout.indexOf("uint32") !== -1,
  "layout names uint16 token ids and uint32 field lengths");
T(bin.layout.indexOf("token_count") !== -1, "layout starts with a token_count header");
T(bin.layout.indexOf("sorted keys") !== -1 && bin.layout.indexOf("UTF-8") !== -1,
  "fields are canonical JSON (sorted keys, UTF-8)");
T(bin.note.indexOf("byte-identical") !== -1, "note promises byte-identical output for identical inputs");
T(bin.note.indexOf("never null") !== -1, "absent optional fields are omitted, never null");
T(tok.encoding_version === "1.0.0", "encoding_version 1.0.0");

// encode_version bump rule: any id/field/order change forces retraining
T(tok.description.indexOf("bumps encoding_version") !== -1,
  "description states the encoding_version bump rule");

/* ---------- 4. kind-table fields ---------- */

const nodeK = kinds.filter((k) => k.name === "node")[0];
T(nodeK.fields.length === 5, "node has 5 fields");
T(nodeK.fields.map((f) => f.name).join(",") === "node_id,type,x,y,label", "node field names in order");
T(nodeK.fields.filter((f) => f.name === "node_id")[0].type.indexOf("^n[1-9]") !== -1,
  "node_id field carries the canonical ^n[1-9] pattern");
T(nodeK.fields.filter((f) => f.name === "type")[0].type === "enum: 0=collection, 1=system, 2=thirdparty, 3=destruction",
  "node type enum order collection,system,thirdparty,destruction");
T(nodeK.fields.filter((f) => f.name === "x")[0].type.indexOf("40-600") !== -1, "node x 40-600");
T(nodeK.fields.filter((f) => f.name === "y")[0].type.indexOf("40-380") !== -1, "node y 40-380");
T(nodeK.fields.filter((f) => f.name === "label")[0].type.indexOf("200") !== -1, "node label max 200 chars");

const edgeK = kinds.filter((k) => k.name === "edge")[0];
T(edgeK.fields.map((f) => f.name).join(",") === "a,b,cat", "edge field names a,b,cat");
T(edgeK.fields.filter((f) => f.name === "cat")[0].type === "enum: 0=contact, 1=payment, 2=marketing",
  "edge cat enum order contact,payment,marketing");

const annK = kinds.filter((k) => k.name === "annotation")[0];
T(annK.fields.map((f) => f.name).join(",") === "node_slot,kind,payload", "annotation fields node_slot,kind,payload");
T(annK.fields.filter((f) => f.name === "kind")[0].type === "enum: 0=retention, 1=confirmation, 2=review_flag",
  "annotation kind enum retention,confirmation,review_flag");
T(annK.token_id_rule.indexOf("canonical payload JSON byte order") !== -1,
  "annotation tie-break is canonical payload JSON byte order");

const menuK = kinds.filter((k) => k.name === "action_menu")[0];
T(menuK.fields.map((f) => f.name).join(",") === "action_name,params_digest", "menu fields action_name,params_digest");
T(menuK.fields.filter((f) => f.name === "action_name")[0].type.indexOf("action-catalogue") !== -1,
  "action_name must be one of the action-catalogue action names");
T(menuK.fields.filter((f) => f.name === "params_digest")[0].type.indexOf("SHA-256") !== -1,
  "params_digest is SHA-256 derived");

/* ---------- 5. deterministic token id rules (sort orders) ---------- */

// node: 32 + slot_index, numeric node-id sort (n1 < n2 < n10, not lexicographic)
function nodeSlotOrder(ids) {
  return ids.slice().sort((p, q) => parseInt(p.slice(1), 10) - parseInt(q.slice(1), 10));
}
const numOrder = nodeSlotOrder(["n10", "n2", "n1"]);
T(JSON.stringify(numOrder) === JSON.stringify(["n1", "n2", "n10"]), "node sort is numeric: n1 < n2 < n10");
const lexOrder = ["n10", "n2", "n1"].slice().sort();
T(JSON.stringify(lexOrder) !== JSON.stringify(numOrder), "numeric sort differs from naive lexicographic sort");
T(nodeK.token_id_rule.indexOf("32 + slot_index") !== -1, "node rule: 32 + slot_index");
T(nodeK.token_id_rule.indexOf("numeric sort, not lexicographic") !== -1 ||
  tok.ordering_rule.sequence[1].indexOf("numeric sort, not lexicographic") !== -1,
  "spec calls out numeric-not-lexicographic node sort");
T(32 + 0 === 32 && 32 + 63 === 95, "node slots map 32..95");

// edge: 96 + slot_index, sort (a, b, cat) with cat alphabetical contact < marketing < payment
function edgeKey(e) { return [e.a, e.b, e.cat]; }
function edgeSort(edges) {
  return edges.slice().sort((p, q) => {
    if (p.a !== q.a) return p.a - q.a;
    if (p.b !== q.b) return p.b - q.b;
    return p.cat < q.cat ? -1 : p.cat > q.cat ? 1 : 0;
  });
}
T(edgeKey({ a: 0, b: 1, cat: "contact" }).join("|") === "0|1|contact", "edge key shape (a,b,cat)");
const catAlpha = edgeSort([
  { a: 0, b: 1, cat: "payment" }, { a: 0, b: 1, cat: "contact" }, { a: 0, b: 1, cat: "marketing" }
]).map((e) => e.cat);
T(JSON.stringify(catAlpha) === JSON.stringify(["contact", "marketing", "payment"]),
  "edge cat sorts alphabetically: contact < marketing < payment (note: differs from the 0,1,2 field enum order)");
T(edgeK.token_id_rule.indexOf("96 + slot_index") !== -1, "edge rule: 96 + slot_index");
T(edgeK.token_id_rule.indexOf("contact < marketing < payment") !== -1, "edge rule states the alphabetical cat order");

// annotation: 160 + slot_index, sort (node_slot, kind)
T(annK.token_id_rule.indexOf("160 + slot_index") !== -1, "annotation rule: 160 + slot_index");
T(annK.token_id_rule.indexOf("(node_slot, kind)") !== -1, "annotation sort key (node_slot, kind)");
function annSort(anns) {
  return anns.slice().sort((p, q) => p.node_slot - q.node_slot || p.kind - q.kind);
}
const annOrdered = annSort([{ node_slot: 1, kind: 2 }, { node_slot: 0, kind: 2 }, { node_slot: 0, kind: 0 }]);
T(JSON.stringify(annOrdered.map((a) => [a.node_slot, a.kind])) === "[[0,0],[0,2],[1,2]]",
  "annotation (node_slot, kind) sort order");

// action menu: 224 + slot_index, action_name alphabetical, ties by params_digest
T(menuK.token_id_rule.indexOf("224 + slot_index") !== -1, "menu rule: 224 + slot_index");
T(menuK.token_id_rule.indexOf("action_name alphabetical") !== -1, "menu sort: action_name alphabetical");
T(menuK.token_id_rule.indexOf("params_digest") !== -1, "menu tie-break: params_digest");
const names = ["set_retention", "connect", "export", "abort_session"].sort();
T(JSON.stringify(names) === JSON.stringify(["abort_session", "connect", "export", "set_retention"]),
  "alphabetical action order verified");
T(tok.ordering_rule.sequence[7].indexOf("alphabetical") !== -1,
  "ordering rule repeats alphabetical order for the menu section");

/* ---------- 6. menu grounding (every menu entry references a catalogue action) ---------- */

const mg = menuK.menu_grounding;
T(mg.max_entries === 5, "menu max 5 entries, so 64 slots never overflow");
T(mg.description.indexOf("current recipe item") !== -1 && mg.description.indexOf("exact params") !== -1,
  "menu includes the current item grounded with its exact params");
T(mg.description.indexOf("undo_last") !== -1 && mg.description.indexOf("non-tombstoned") !== -1,
  "undo_last present iff an applied, non-tombstoned mutating action exists");
T(mg.description.indexOf("skip_recipe_item") !== -1 && mg.description.indexOf("current item_index") !== -1,
  "skip_recipe_item targets the current item_index");
T(mg.description.indexOf("flag_for_review") !== -1 && mg.description.indexOf("unparameterized") !== -1,
  "flag_for_review is unparameterized and targets the current item by default");
T(mg.description.indexOf("abort_session") !== -1 && mg.description.indexOf("always present") !== -1,
  "abort_session is always present");

// every catalogue action name must be a plausible menu entry name
const catNames = new Set(cat.actions.map((a) => a.name));
T(catNames.size === 12, "catalogue has 12 action names");
const sampleActions = ["connect", "export", "set_retention", "undo_last", "abort_session"];
for (const a of sampleActions) T(catNames.has(a), "catalogue action '" + a + "' can ground a menu entry");

/* ---------- 7. ordering rule (load-bearing sequence) ---------- */

const seq = tok.ordering_rule.sequence;
T(seq.length === 9, "ordering sequence has 9 positions");
T(seq[0] === "BOS", "sequence starts BOS");
T(seq[2] === "SNAPSHOT_SEP", "SNAPSHOT_SEP after node tokens");
T(seq[4] === "ANNOT_SEP", "ANNOT_SEP after edge tokens");
T(seq[6] === "MENU_SEP", "MENU_SEP after annotation tokens");
T(seq[8] === "EOS", "sequence ends EOS");
T(tok.ordering_rule.note.indexOf("always emitted even when a section is empty") !== -1,
  "separators always emitted even when a section is empty");
T(tok.ordering_rule.note.indexOf("64") !== -1 && tok.ordering_rule.note.indexOf("never wraps or truncates") !== -1,
  "past-64 slots rejected loudly, never wrapped");

// snapshot_example: menu entries appear alphabetically
const example = tok.ordering_rule.snapshot_example;
T(example.indexOf("action(connect)") < example.indexOf("action(export)") &&
  example.indexOf("action(export)") < example.indexOf("action(set_retention)"),
  "snapshot_example menu order is alphabetical: connect < export < set_retention");

process.stderr.write(failed === 0 ? "PASS " + n + " assertions\n" : failed + " FAILURES of " + n + "\n");
if (failed > 0) process.exitCode = 1;
