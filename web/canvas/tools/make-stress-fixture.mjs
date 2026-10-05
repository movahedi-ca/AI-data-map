/* tools/make-stress-fixture.mjs - builds fixtures/stress-45.xlsx.
 * 45 systems (8 collection, 20 internal, 12 third party, 5 destruction) and
 * 60 data flows chained collection -> system -> system -> third party, some
 * ending in destruction. Template headers copied from the Phase 1 fixture
 * maker so the column mapper recognizes them. Deterministic (seeded RNG).
 * Run from the canvas working dir: node tools/make-stress-fixture.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const P1 = path.resolve(HERE, "../../../phase1/ui/web-import/vendor/xlsx.full.min.js");
const XLSX = require(P1);

const OUT = path.resolve(HERE, "../fixtures");
fs.mkdirSync(OUT, { recursive: true });

// Template headers, copied from phase1/ui/tools/make-fixtures.mjs.
const SYS_H = ["System / application name", "Type", "Data categories", "Purposes of use",
  "Lawful basis", "Retention period", "Storage location", "Owner / department", "Notes"];
const FLOW_H = ["From (system)", "To (system)", "Data categories transferred", "Purpose of transfer",
  "Cross-border?", "Destination", "Safeguards", "Notes"];

// Tiny deterministic RNG so the fixture is stable across runs.
let seed = 20261004;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }

const collections = [
  "Web checkout", "Mobile app signup", "Store POS", "Call center",
  "Landing page lead form", "Event registration desk", "Partner referral portal",
  "Newsletter signup widget",
];
const systems = [
  "Order database", "CRM", "Data warehouse", "Billing ledger",
  "Identity directory", "Support ticketing", "Email service internal",
  "Marketing automation", "Consent register", "Loyalty engine",
  "Fraud screening", "Session store", "Search index", "File vault",
  "Analytics pipeline", "Notification hub", "Returns service",
  "Subscription manager", "Help center wiki", "ETL staging area",
];
const thirdParties = [
  "AcmePay processor", "MailBlast ESP", "Trackly analytics", "SegmentBridge CDP",
  "HelpDesk SaaS", "CloudVault backups", "AdNet DSP", "SurveyFlow",
  "ChatWidget vendor", "Printful logistics", "RiskScore API", "SMS relay vendor",
];
const destructions = [
  "Nightly backup rotation", "Retention purger job", "Secure shred vendor",
  "Log expiry sweeper", "Test data wiper",
];
const sysMeta = { collection: collections, system: systems, thirdparty: thirdParties, destruction: destructions };

// Per-type field defaults; every system gets a realistic row.
const CAT_BY_TYPE = {
  collection: "name, email, address",
  system: "customer profile data",
  thirdparty: "hashed identifiers, event data",
  destruction: "expired records",
};
const PURPOSE_BY_TYPE = {
  collection: "collect at point of contact",
  system: "internal processing",
  thirdparty: "outsourced processing",
  destruction: "secure disposal",
};
const sysRows = [["Fill in one row per system. Delete the example rows before you start."]];
sysRows.push(SYS_H);
for (const [type, names] of Object.entries(sysMeta)) {
  const label = { collection: "Collection point", system: "Internal system",
    thirdparty: "Third party", destruction: "Destruction / disposal" }[type];
  names.forEach((name, i) => {
    sysRows.push([name, label, CAT_BY_TYPE[type], PURPOSE_BY_TYPE[type], "Contract",
      type === "destruction" ? "30 days" : "7 years", "Quebec", "Data team " + (i + 1), ""]);
  });
}

// Flows: each collection feeds 2 systems; systems chain; third parties hang
// off systems; destructions receive end-of-life flows. Category keywords are
// chosen so the engine proposes contact/payment/marketing automatically.
const CAT_TEXT = {
  contact: ["name, email", "customer support records"],
  payment: ["card number, billing address", "charge for the order"],
  marketing: ["email address", "send newsletter campaigns"],
};
const flowPairs = [];
// 8 collections -> 2 internal systems each (16 flows).
for (let c = 0; c < collections.length; c++) {
  const targets = new Set();
  while (targets.size < 2) targets.add(Math.floor(rand() * systems.length));
  for (const t of targets) flowPairs.push([collections[c], systems[t], c % 2 === 0 ? "payment" : "contact"]);
}
// 24 system -> system hops (chains), some systems appear twice.
for (let i = 0; i < 24; i++) {
  const a = Math.floor(rand() * systems.length);
  let b = Math.floor(rand() * systems.length);
  if (b === a) b = (b + 1) % systems.length;
  flowPairs.push([systems[a], systems[b], pick(["contact", "contact", "payment", "marketing"])]);
}
// 14 system -> third party flows.
for (let i = 0; i < 14; i++) {
  const a = systems[Math.floor(rand() * systems.length)];
  const tp = thirdParties[i % thirdParties.length];
  const cat = i % 3 === 0 ? "marketing" : (i % 3 === 1 ? "contact" : "payment");
  flowPairs.push([a, tp, cat]);
}
// 6 flows into destruction (systems and third parties age out).
for (let i = 0; i < 6; i++) {
  const src = i < 4 ? systems[Math.floor(rand() * systems.length)] : thirdParties[Math.floor(rand() * thirdParties.length)];
  flowPairs.push([src, destructions[i % destructions.length], "contact"]);
}

const flowRows = [["Fill in one row per data flow."]];
flowRows.push(FLOW_H);
flowPairs.forEach(([from, to, cat], i) => {
  const [dataCat, purpose] = CAT_TEXT[cat];
  flowRows.push([from, to, dataCat, purpose, i % 5 === 0 ? "Yes" : "No",
    i % 5 === 0 ? "United States" : "", i % 5 === 0 ? "DPA" : "TLS", "stress row " + (i + 1)]);
});

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sysRows), "Systems");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(flowRows), "Flows");
const outPath = path.join(OUT, "stress-45.xlsx");
fs.writeFileSync(outPath, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

// Read back and verify counts (the vendored readFile has no fs hook, so read from the buffer).
const buf = fs.readFileSync(outPath);
const back = XLSX.read(buf, { type: "buffer" });
const sysN = XLSX.utils.sheet_to_json(back.Sheets.Systems, { header: 1 }).length - 2;
const flowN = XLSX.utils.sheet_to_json(back.Sheets.Flows, { header: 1 }).length - 2;
console.log("wrote", outPath, fs.statSync(outPath).size + " bytes");
console.log("systems rows:", sysN, "(expected 45)");
console.log("flow rows:", flowN, "(expected 60)");
if (sysN !== 45 || flowN !== 60) process.exitCode = 1;
