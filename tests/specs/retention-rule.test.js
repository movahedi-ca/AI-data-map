"use strict";
/*
 * retention-rule.test.js: the hard retention rule contracts.
 * Run: node tests/specs/retention-rule.test.js
 *
 * Covers: specs/RETENTION-RULE.md invariants (12 verified rows, every row
 * states a range with statute + section and an as-of date, Law 25 sets no
 * retention periods), enforcement wording, and the rule driven through the
 * real MCP validator: every table row's cited range must pass, any fixture
 * claiming "Law 25 requires N years" must fail, single numbers must fail.
 */

global.self = global;

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const md = fs.readFileSync(path.join(REPO, "specs", "RETENTION-RULE.md"), "utf8");
const { validateRecipe, knownIntents } = require(path.join(REPO, "mcp", "server.js"));
const known = knownIntents();

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

/* ---------- 1. the hard rule statement ---------- */

T(md.indexOf("ranges only, never single numbers") !== -1, "hard rule: ranges only, never single numbers");
T(md.indexOf("statute that sets the period, with the section, plus an as-of date") !== -1,
  "hard rule: cite statute + section + as-of date");
T(md.indexOf("\"verify\"** flags, never compliance verdicts") !== -1,
  "hard rule: verify flags, never compliance verdicts");
T(md.indexOf("If an entry cannot cite a statute, it ships with a \"verify\" flag and no range") !== -1,
  "uncited entries ship with a verify flag and no range");
T(md.indexOf("floor plus one year") !== -1, "range convention: floor plus one year");

// Law 25 never sources a number
T(md.indexOf("sets no retention periods") !== -1, "Law 25 sets no retention periods (stated)");
T(md.indexOf("destroy or anonymize when the purposes are fulfilled") !== -1,
  "Law 25 contributes only the destroy-or-anonymize trigger");
T(md.indexOf("never contributes a number") !== -1, "Law 25 never contributes a number (stated)");

// enforcement wording
T(md.indexOf("every entry that implies a retention period must cite the statute name, section, and an as-of date") !== -1,
  "enforcement 1: cite statute name, section, as-of date");
T(md.indexOf("no bare numbers remain") !== -1, "deploy checklist: no bare numbers remain");
T(md.indexOf("every uncited entry still carries its \"verify\" flag") !== -1,
  "deploy checklist: uncited entries keep the verify flag");

/* ---------- 2. the verified table: 12 rows, all ranges, all cited ---------- */

function tableRows() {
  const rows = [];
  for (const line of md.split("\n")) {
    if (line.indexOf("|") !== 0) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells[1] === "Record type" || cells[1] === "" || cells[1].indexOf("---") === 0) continue;
    rows.push(cells.slice(1, 6));
  }
  return rows;
}
const rows = tableRows();
T(rows.length === 12, "12 verified retention rows, got " + rows.length);

const secRe = /([Ss][Ss]?\.?\s*[0-9]+|[Aa][Rr][Tt]\.?\s*[0-9]+|[Aa][Rr][Tt][Ii][Cc][Ll][Ee]\s+[0-9]+|[Rr]\.?\s*[0-9]+(\.[0-9]+)*|\u00a7\s*[0-9]+)/;
for (const [recordType, range, floor, statute, asOf] of rows) {
  const short = recordType.slice(0, 32);
  T(/\d+ to \d+/.test(range), "row states a range (N to M): " + short);
  T(range.indexOf("years") !== -1 || range.indexOf("Duration") !== -1, "row range names the unit: " + short);
  T(statute.length > 8, "row cites a statute (>8 chars): " + short);
  T(secRe.test(statute), "row statute names act + section: " + short);
  T(/^\d{4}-\d{2}-\d{2}$/.test(asOf), "row has an as-of date: " + short);
  T(asOf === "2026-10-04", "row as-of date is 2026-10-04: " + short);
  T(floor.length > 10, "row quotes the statutory floor verbatim: " + short);
}

/* ---------- 3. every table row passes the real validator ---------- */

function retItem(p) {
  return { intent: "set_retention", params: Object.assign(
    { node_id: "n1", record_type: "Records", as_of: "2026-10-04" }, p) };
}
function rangeFrom(cell) {
  const m = cell.match(/(\d+)\s+to\s+(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
for (const [recordType, range, floor, statute, asOf] of rows) {
  const r = rangeFrom(range);
  T(r !== null && r[1] === r[0] + 1, "row range follows the floor-plus-one convention: " + recordType.slice(0, 32));
  // The executor caps statute at 300 chars (schema maxLength 300, enforced
  // by the MCP validator). Rows whose table cell carries a compound citation
  // longer than 300 chars are carried in recipes as their primary citation
  // (the first segment before ";"), which still names act + section.
  const cite = statute.length <= 300 ? statute : statute.split(";")[0].trim();
  if (statute.length > 300) {
    T(cite.length <= 300, "compound citation longer than 300 chars uses its primary citation: " + recordType.slice(0, 32));
    T(secRe.test(cite), "primary citation still names act + section: " + recordType.slice(0, 32));
  }
  const params = {
    record_type: recordType, range_min_years: r[0], range_max_years: r[1],
    statute: cite, as_of: asOf
  };
  if (range.indexOf("after") !== -1 || range.indexOf("Duration of services") !== -1) {
    params.anchor = "event anchor from the row";
  }
  const err = validateRecipe({ recipe_id: "ret-row", schema_version: "1.0.0",
    items: [retItem(params)] }, known);
  T(err === null, "table row passes validateRecipe: " + recordType.slice(0, 32));
}

/* ---------- 4. must-fail: Law 25 never sources a number ---------- */

const law25Fixtures = [
  { statute: "Law 25, s. 23", why: "plain Law 25 citation" },
  { statute: "Loi 25, article 23", why: "French Loi 25 citation" },
  { statute: "Bill 64, s. 23", why: "Bill 64 predecessor citation" },
  { statute: "LPRPSP, s. 23", why: "LPRPSP acronym citation" },
  { statute: "Income Tax Act, s. 230(4)(b), per Law 25 guidance", why: "Law 25 smuggled into a real citation" }
];
for (const f of law25Fixtures) {
  const err = validateRecipe({ recipe_id: "law25-no", schema_version: "1.0.0",
    items: [retItem({ range_min_years: 6, range_max_years: 7, statute: f.statute })] }, known);
  T(err !== null && /Law 25 sets no retention periods/.test(err.reason),
    "must fail, Law 25 cannot source a number: " + f.why);
}

// must-fail: single number, not a range
const single = validateRecipe({ recipe_id: "single", schema_version: "1.0.0",
  items: [retItem({ range_min_years: 6, statute: "Income Tax Act, R.S.C. 1985, c. 1 (5th Supp.), s. 230(4)(b)" })] }, known);
T(single !== null && /range_max_years/.test(single.reason), "must fail: single number is not a range");

// must-fail: min equal to max (not a range either)
const equal = validateRecipe({ recipe_id: "equal", schema_version: "1.0.0",
  items: [retItem({ range_min_years: 6, range_max_years: 6,
    statute: "Income Tax Act, R.S.C. 1985, c. 1 (5th Supp.), s. 230(4)(b)" })] }, known);
T(equal !== null, "must fail: min equal to max is not a range");

// must-fail: missing as_of
const noDate = validateRecipe({ recipe_id: "nodate", schema_version: "1.0.0",
  items: [{ intent: "set_retention", params: { node_id: "n1", record_type: "Tax records",
    range_min_years: 6, range_max_years: 7,
    statute: "Income Tax Act, R.S.C. 1985, c. 1 (5th Supp.), s. 230(4)(b)" } }] }, known);
T(noDate !== null && /as_of/.test(noDate.reason), "must fail: retention without as_of");

// positive: verify_only wording passes with no range and no statute
const verify = validateRecipe({ recipe_id: "verify", schema_version: "1.0.0",
  items: [retItem({ verify_only: true })] }, known);
T(verify === null, "verify_only entry passes with no range and no statute (the only legal uncited form)");

// positive: a full valid retention item passes
const full = validateRecipe({ recipe_id: "full", schema_version: "1.0.0",
  items: [retItem({ range_min_years: 6, range_max_years: 7,
    statute: "Loi sur l'administration fiscale, RLRQ, c. A-6.002, ss. 34, 35.3" })] }, known);
T(full === null, "full cited range passes");

process.stderr.write(failed === 0 ? "PASS " + n + " assertions\n" : failed + " FAILURES of " + n + "\n");
if (failed > 0) process.exitCode = 1;
