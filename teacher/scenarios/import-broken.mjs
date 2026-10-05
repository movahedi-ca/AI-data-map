#!/usr/bin/env node
/* scenarios/import-broken.mjs - pilot teacher scenario: broken template in,
 * recovery grammar out.
 *
 * Generates a deliberately broken .xlsx in the scenario (duplicate system
 * names, a flow referencing a missing system, a flow row with no data
 * categories), uploads it to the served Phase 1 demo in a real browser, and
 * verifies the page flags every problem inline: the LIKELY_DUPLICATE warning
 * for the doubled system, the DANGLING_REF error for the phantom flow
 * endpoint, and the explicit default-category suggestion for the category-less
 * row. Nothing may be silently merged. Then the session is traced through the
 * Executor+Recorder as flag_for_review (with the observed reasons) followed
 * by abort_session ("broken template rejected by user"), and the shard is
 * written to outDir as pilot-import-broken.
 *
 * Deterministic: the generated workbook is byte-identical on every run
 * (fixed ZIP timestamps, fixed row order, no clock or random input).
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  acceptGate,
  waitStep,
  uploadFile,
  pickSheets,
  mappingGuesses,
  reviewState,
} from "./common.mjs";

export const name = "import-broken";
export const domain = "data-mapping";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ABORT_REASON = "broken template rejected by user";

function check(cond, msg) {
  if (!cond) throw new Error("scenario assertion failed: " + msg);
  console.log("  ok - " + msg);
}

/* ---------- minimal deterministic .xlsx writer ----------
 * Stored (uncompressed) ZIP with inline strings. Fixed DOS timestamps, so
 * the same rows always produce the same bytes. SheetJS (vendored in the
 * demo's import worker) reads stored entries without complaint. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // stored, no compression
    lh.writeUInt16LE(0, 10); // fixed mod time
    lh.writeUInt16LE(0x0021, 12); // fixed mod date: 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, f.data);
    central.push({ nameBuf, crc, size: f.data.length, offset });
    offset += 30 + nameBuf.length + f.data.length;
  }
  const centralStart = offset;
  const cparts = [];
  for (const c of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x0021, 14);
    ch.writeUInt32LE(c.crc, 16);
    ch.writeUInt32LE(c.size, 20);
    ch.writeUInt32LE(c.size, 24);
    ch.writeUInt16LE(c.nameBuf.length, 28);
    ch.writeUInt32LE(0, 30);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(c.offset, 42);
    cparts.push(ch, c.nameBuf);
  }
  const centralBuf = Buffer.concat(cparts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuf, end]);
}

function escXml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function colLetter(i) {
  let s = "";
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

function sheetXml(rows) {
  const body = rows
    .map(
      (row, ri) =>
        '<row r="' +
        (ri + 1) +
        '">' +
        row
          .map(
            (v, ci) =>
              '<c r="' +
              colLetter(ci) +
              (ri + 1) +
              '" t="inlineStr"><is><t>' +
              escXml(v) +
              "</t></is></c>"
          )
          .join("") +
        "</row>"
    )
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    "<sheetData>" +
    body +
    "</sheetData></worksheet>"
  );
}

const SYS_HEADERS = [
  "System / application name",
  "Type",
  "Data categories",
  "Purposes of use",
  "Lawful basis",
  "Retention period",
  "Storage location",
  "Owner / department",
  "Notes",
];
const FLOW_HEADERS = [
  "From (system)",
  "To (system)",
  "Data categories transferred",
  "Purpose of transfer",
  "Cross-border?",
  "Destination",
  "Safeguards",
  "Notes",
];

function brokenWorkbook() {
  const systems = [
    SYS_HEADERS,
    ["Acme CRM", "Internal system", "customer data", "Sales pipeline", "Contract", "7 years (tax law)", "Canada", "Sales", ""],
    ["Acme CRM", "Internal system", "customer data", "Sales pipeline", "Contract", "7 years (tax law)", "Canada", "Sales", ""],
    ["Beacon Analytics", "Third party", "usage data", "Product analytics", "Consent", "13 months", "United States", "Product", ""],
  ];
  const flows = [
    FLOW_HEADERS,
    ["Acme CRM", "Beacon Analytics", "customer data", "Product sync", "No", "", "", ""],
    ["Acme CRM", "Phantom Vendor", "customer data", "Partner share", "No", "", "", ""],
    ["Beacon Analytics", "Acme CRM", "", "Nightly export", "No", "", "", ""],
  ];
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    "</Types>";
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>";
  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    "<sheets>" +
    '<sheet name="Systems" sheetId="1" r:id="rId1"/>' +
    '<sheet name="Data flows" sheetId="2" r:id="rId2"/>' +
    "</sheets></workbook>";
  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    "</Relationships>";
  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills><fill><patternFill patternType="none"/></fill></fills>' +
    '<borders><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
    "</styleSheet>";
  return buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbook, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(workbookRels, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheetXml(systems), "utf8") },
    { name: "xl/worksheets/sheet2.xml", data: Buffer.from(sheetXml(flows), "utf8") },
    { name: "xl/styles.xml", data: Buffer.from(styles, "utf8") },
  ]);
}

/* ---------- scenario ---------- */

export async function run(ctx) {
  const { client, base, specsDir, libDir, outDir } = ctx;
  console.log("[" + name + "] navigate " + base + "/index.html");
  await client.callTool("navigate", { url: base + "/index.html" });
  await acceptGate(client);

  const bytes = brokenWorkbook();
  console.log("[" + name + "] generated broken workbook (" + bytes.length + " bytes)");
  await uploadFile(client, "broken-template.xlsx", XLSX_MIME, bytes);

  await waitStep(client, "imp-step-sheets");
  const picked = await pickSheets(client, "Systems", "Data flows");
  console.log("[" + name + "] sheets: " + picked.sysText + " / " + picked.flowsText);

  await client.callTool("click", { selector: "#imp-sheets-next" });
  await waitStep(client, "imp-step-map");
  const guesses = await mappingGuesses(client);
  check(guesses.length === 17, "mapping step shows 17 prefilled column guesses");
  await client.callTool("click", { selector: "#imp-map-next" });

  await waitStep(client, "imp-step-review");
  const rev = await reviewState(client);

  // Nothing silently merged: both Acme CRM rows are listed as systems.
  const acmeRows = rev.sysRows.filter((r) => r.name === "Acme CRM");
  check(acmeRows.length === 2, "duplicate system rows kept separate, not merged (2 Acme CRM rows)");
  check(rev.sysRows.length === 3, "review lists 3 systems");

  const warnings = rev.flags.filter((f) => f.cls.indexOf("warning") !== -1).map((f) => f.text);
  const errors = rev.flags.filter((f) => f.cls.indexOf("error") !== -1).map((f) => f.text);
  console.log("[" + name + "] warnings: " + JSON.stringify(warnings).slice(0, 400));
  console.log("[" + name + "] errors: " + JSON.stringify(errors).slice(0, 400));
  check(
    warnings.some((t) => t.indexOf("Acme CRM") !== -1 && t.toLowerCase().indexOf("same system") !== -1),
    "LIKELY_DUPLICATE warning inline for the two Acme CRM rows"
  );
  check(
    errors.some((t) => t.indexOf("Phantom Vendor") !== -1),
    "DANGLING_REF error inline for the flow to Phantom Vendor"
  );

  // The category-less row gets an explicit default suggestion, not a guess.
  const emptyCat = rev.flowRows.find((f) => f.from === "Beacon Analytics" && f.to === "Acme CRM");
  check(!!emptyCat, "category-less flow row present in review");
  check(
    emptyCat.badge === "Suggested" && emptyCat.note.indexOf("default category") !== -1,
    "category-less flow shows an explicit default suggestion with its reason"
  );

  // Trace the recovery grammar: flag with the observed reasons, then abort.
  const observed = warnings
    .concat(errors)
    .map((t) => t.replace(/\s+/g, " ").trim().slice(0, 140));
  let reason =
    "Broken template rejected at review. Observed flags: " + observed.join(" // ");
  if (reason.length > 500) reason = reason.slice(0, 497) + "...";
  check(reason.length >= 1, "flag reason carries the observed flags");

  const recipe = {
    name: "Pilot import: broken template flagged at review, session aborted",
    recipe_id: "pilot-import-broken-01",
    schema_version: "1.0.0",
    items: [
      { intent: "flag_for_review", params: { item_index: 0, reason } },
      { intent: "abort_session", params: { reason: ABORT_REASON } },
    ],
  };

  const { Executor } = await import(pathToFileURL(path.join(libDir, "executor.mjs")).href);
  const { Recorder } = await import(pathToFileURL(path.join(libDir, "recorder.mjs")).href);
  const executor = new Executor(recipe, specsDir);
  const recorder = new Recorder({ executor, shard: "pilot-import-broken", domain, recipe });
  for (const item of recipe.items) {
    await recorder.rec(item.intent, item.params);
  }
  const { jsonlPath, manifestPath } = await recorder.writeShard(outDir);
  check(fs.existsSync(jsonlPath), "shard written: " + jsonlPath);

  return {
    name,
    domain,
    actions: recipe.items.length,
    records: recorder.records.length,
    shard: "pilot-import-broken",
    jsonlPath,
    manifestPath,
  };
}
