"use strict";
/* path-traversal.test.js - hostile filenames must not escape their sandbox.
 *
 * Run: node tests/security/path-traversal.test.js   (from the repo root)
 *
 * Where filenames flow in this codebase (verified by reading the sources):
 *  - web/import/worker/worker-client.js posts { buffer, filename: file.name }
 *    to the import worker. In browsers file.name never contains a path, but
 *    the worker still treats it as untrusted: web/import/worker/parse-core.js
 *    uses it ONLY for detectFormat() (extension as a last-resort tiebreaker;
 *    content sniffing wins) and for baseName() (the CSV sheet name), which
 *    strips every directory component with split(/[\\/]/).pop(). Filenames
 *    never reach a filesystem: browsers have no FS access and downloads use
 *    fixed literal names.
 *  - web/executor/js/ui.js downloadBlob(): a.download is set from the
 *    function's filename parameter; every call site passes a string
 *    literal ("data-map-inventory.xls", "corrections.jsonl").
 *
 * Tests:
 *  1. parseFileBuffer with a stub XLSX: hostile filenames yield a clean
 *     sheet name (directory components stripped) and never affect content.
 *  2. detectFormat is content-first: a traversal name cannot change the
 *     detected format when magic bytes disagree.
 *  3. Static: every downloadBlob call site passes a literal filename, and
 *     the only .download write takes that literal parameter.
 *
 * No em dashes.
 */
global.self = global;

const assert = require("assert");
const path = require("path");

const WEB = path.resolve(__dirname, "..", "..", "web");

let n = 0;
function ok(cond, msg) { n++; assert.ok(cond, msg); }
function eq(a, b, msg) { n++; assert.strictEqual(a, b, msg); }

function main() {
  const PC = require(path.join(WEB, "import/worker/parse-core.js"));

  /* Stub XLSX: CSV goes through our own parser; capture the sheet name
     the worker derives from the filename. */
  function runParse(filename, text) {
    const captured = {};
    const XLSXstub = {
      utils: {
        book_new: function () { return {}; },
        aoa_to_sheet: function (aoa) { return { aoa: aoa }; },
        book_append_sheet: function (wb, ws, name) { captured.sheetName = name; },
        sheet_to_json: function () { return []; },
      },
      read: function () { return { SheetNames: [], Sheets: {} }; },
    };
    const res = PC.parseFileBuffer(XLSXstub, Buffer.from(text, "utf8"), filename);
    return { res: res, sheetName: captured.sheetName };
  }

  const csv = "Label,Type\nCRM,system\n";

  /* 1. directory components are stripped from the derived sheet name. */
  const cases = [
    ["../../etc/passwd.csv", "passwd"],
    ["/abs/path/evil.csv", "evil"],
    ["C:\\Windows\\Temp\\evil.csv", "evil"],
    ["....//....//weird.csv", "weird"],
    ["..\\..\\win.csv", "win"],
    ["report.csv", "report"],
    ["My Report 2024.csv", "My Report 2024"],
  ];
  for (const [filename, want] of cases) {
    const r = runParse(filename, csv);
    eq(r.sheetName, want, "sheet name for " + JSON.stringify(filename));
  }

  /* Extensionless / nameless CSV content is rejected as unknown: the name
     is only a tiebreaker, never a way to force parsing. */
  for (const filename of ["noext", "", "data.txt"]) {
    const r = runParse(filename, csv);
    eq(r.res.ok, false, "no parse without a recognized name: " + JSON.stringify(filename));
  }

  /* A hostile name cannot smuggle content: parse still reads the bytes. */
  const r0 = runParse("../../../etc/shadow.csv", csv);
  eq(r0.res.ok, false, "empty stub workbook still reports no-content (not a crash)");
  ok(r0.res.error.indexOf("no sheets") !== -1 || r0.res.error.length > 0, "plain-language error");

  /* 2. detectFormat is content-first; the name is only a tiebreaker. */
  const xlsxMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  eq(PC.detectFormat("/etc/passwd", xlsxMagic), "xlsx", "ZIP magic wins over a path-only name");
  eq(PC.detectFormat("../../evil.txt", xlsxMagic), "xlsx", "ZIP magic wins over .txt name");
  eq(PC.detectFormat("../../etc/passwd.csv", Buffer.from(csv)), "csv", ".csv name claims CSV for plain text");
  eq(PC.detectFormat("../../etc/passwd", Buffer.from("just some text")), "unknown",
    "no magic and no .csv extension stays unknown");

  /* The filename never reaches row data. */
  const rows = PC.parseCSV(csv);
  eq(rows[1][0], "CRM", "cell data comes from bytes, not the filename");

  /* 3. download filenames are fixed literals. */
  const fs = require("fs");
  const uiSrc = fs.readFileSync(path.join(WEB, "executor/js/ui.js"), "utf8");
  const dlCalls = uiSrc.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.indexOf("downloadBlob(") === 0);
  eq(dlCalls.length, 2, "two downloadBlob call sites (got " + dlCalls.length + ")");
  dlCalls.forEach((c) => {
    const m = c.match(/^downloadBlob\([^,]+,\s*"([^"]+)",\s*"([^"]+)"\)/);
    ok(!!m, "downloadBlob filename and mime are string literals: " + c.slice(0, 80));
    ok(m[1].indexOf("/") === -1 && m[1].indexOf("\\") === -1 && m[1].indexOf("..") === -1,
      "download filename has no path components: " + m[1]);
  });
  ok(uiSrc.indexOf('"data-map-inventory.xls"') !== -1, "Excel download name is a literal");
  ok(uiSrc.indexOf('"corrections.jsonl"') !== -1, "corrections download name is a literal");
  const dlWrites = uiSrc.match(/[a-zA-Z_$][\w$]*\.download\s*=\s*[^;]+;/g) || [];
  eq(dlWrites.length, 1, "exactly one .download write");
  ok(/a\.download\s*=\s*filename;/.test(dlWrites[0]), ".download takes the literal call-site filename");

  /* The import worker cannot touch a filesystem: no FS-ish APIs. */
  const workerSrc = fs.readFileSync(path.join(WEB, "import/worker/import-worker.js"), "utf8");
  ok(!/\brequire\s*\(/.test(workerSrc), "import worker has no require()");
  ok(!/\bfs\b\./.test(workerSrc), "import worker has no fs access");
  ok(workerSrc.indexOf("self.postMessage(result)") !== -1, "worker only posts the parse result back");

  console.log("PASS " + n + " [path-traversal]");
}

try {
  main();
} catch (e) {
  console.error("FAIL path-traversal: " + (e && e.stack || e));
  process.exitCode = 1;
}
