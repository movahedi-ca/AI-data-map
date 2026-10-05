/* parse-core.test.js
 *
 * node:test suite for the Phase 1 parser layer.
 * Run: node --test parse-core.test.js   (from this directory)
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const ParseCore = require("./parse-core.js");
const XLSX = require("../vendor/xlsx.full.min.js");

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

// A SpreadsheetML .xls sample matching the frozen guide exporter
// (GUIDE-FREEZE.md section 5): UTF-8 BOM, <?xml, the SpreadsheetML
// namespace, Nodes sheet with disclaimer row / blank row / header,
// Connections sheet with header.
function spreadsheetmlBytes() {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n' +
    ' xmlns:o="urn:schemas-microsoft-com:office:office"\n' +
    ' xmlns:x="urn:schemas-microsoft-com:office:excel"\n' +
    ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
    '<Styles><Style ss:ID="h"><Font ss:Bold="1"/><Interior ss:Color="#EFE9DA" ss:Pattern="Solid"/></Style></Styles>\n' +
    '<Worksheet ss:Name="Nodes"><Table>\n' +
    '<Row><Cell><Data ss:Type="String">DRAFT: this inventory is a working draft. It is not legal advice. Have your privacy advisor review it before you rely on it.</Data></Cell></Row>\n' +
    '<Row><Cell><Data ss:Type="String"></Data></Cell></Row>\n' +
    '<Row><Cell ss:StyleID="h"><Data ss:Type="String">Label</Data></Cell><Cell ss:StyleID="h"><Data ss:Type="String">Type</Data></Cell></Row>\n' +
    '<Row><Cell><Data ss:Type="String">Checkout form</Data></Cell><Cell><Data ss:Type="String">Collection point</Data></Cell></Row>\n' +
    '<Row><Cell><Data ss:Type="String">Shopify</Data></Cell><Cell><Data ss:Type="String">System</Data></Cell></Row>\n' +
    '<Row><Cell><Data ss:Type="String">Klaviyo</Data></Cell><Cell><Data ss:Type="String">Third party</Data></Cell></Row>\n' +
    '</Table></Worksheet>\n' +
    '<Worksheet ss:Name="Connections"><Table>\n' +
    '<Row><Cell ss:StyleID="h"><Data ss:Type="String">From</Data></Cell><Cell ss:StyleID="h"><Data ss:Type="String">To</Data></Cell><Cell ss:StyleID="h"><Data ss:Type="String">Category</Data></Cell></Row>\n' +
    '<Row><Cell><Data ss:Type="String">Checkout form</Data></Cell><Cell><Data ss:Type="String">Shopify</Data></Cell><Cell><Data ss:Type="String">Contact / identity</Data></Cell></Row>\n' +
    '<Row><Cell><Data ss:Type="String">Shopify</Data></Cell><Cell><Data ss:Type="String">Klaviyo</Data></Cell><Cell><Data ss:Type="String">Marketing / consent</Data></Cell></Row>\n' +
    '</Table></Worksheet>\n' +
    '</Workbook>';
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml, "utf8")]);
}

// A real .xlsx built with the vendored SheetJS build, including a
// formatted date cell and a numeric cell.
function xlsxBytes() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["System / application name", "Type", "Since"],
    ["Shopify", "Third party", null],
    ["Klaviyo", "Third party", 1234.5],
  ]);
  ws["C2"] = { t: "d", v: new Date(Date.UTC(2023, 0, 15)), z: "yyyy-mm-dd" };
  ws["!cols"] = undefined;
  XLSX.utils.book_append_sheet(wb, ws, "Systems");
  const flows = XLSX.utils.aoa_to_sheet([
    ["From (system)", "To (system)", "Cross-border?"],
    ["Shopify", "Klaviyo", "Yes"],
  ]);
  XLSX.utils.book_append_sheet(wb, flows, "Data flows");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function headOf(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return view.subarray(0, Math.min(view.length, 8192));
}

function noEmDash(s) {
  assert.ok(!/\u2014/.test(s), "error message must not contain an em dash");
}

/* ------------------------------------------------------------------ */
/* parseCSV                                                            */
/* ------------------------------------------------------------------ */

describe("parseCSV (RFC-4180)", () => {
  test("quoted fields with embedded commas", () => {
    const rows = ParseCore.parseCSV('name,note\nAcme,"fast, cheap"\n');
    assert.deepEqual(rows, [
      ["name", "note"],
      ["Acme", "fast, cheap"],
    ]);
  });

  test("embedded newlines inside quoted fields", () => {
    const rows = ParseCore.parseCSV('a,b\n"x\ny",z\n');
    assert.deepEqual(rows, [
      ["a", "b"],
      ["x\ny", "z"],
    ]);
  });

  test("embedded CRLF inside quoted fields", () => {
    const rows = ParseCore.parseCSV('a,b\r\n"x\r\ny",z\r\n');
    assert.deepEqual(rows, [
      ["a", "b"],
      ["x\r\ny", "z"],
    ]);
  });

  test("CRLF and LF line endings mix cleanly", () => {
    const rows = ParseCore.parseCSV("a,b\r\n1,2\n3,4\r\n");
    assert.deepEqual(rows, [
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test("lone CR is a line break", () => {
    const rows = ParseCore.parseCSV("a,b\r1,2\r");
    assert.deepEqual(rows, [
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("UTF-8 BOM is stripped", () => {
    const rows = ParseCore.parseCSV("\uFEFFa,b\n1,2\n");
    assert.deepEqual(rows, [
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("doubled quotes unescape to one quote", () => {
    const rows = ParseCore.parseCSV('"say ""hi""",b\n');
    assert.deepEqual(rows, [['say "hi"', "b"]]);
  });

  test("empty input gives no rows", () => {
    assert.deepEqual(ParseCore.parseCSV(""), []);
    assert.deepEqual(ParseCore.parseCSV(null), []);
  });

  test("trailing newline does not add a phantom row", () => {
    const rows = ParseCore.parseCSV("a,b\n1,2\n");
    assert.equal(rows.length, 2);
  });

  test("empty fields stay empty strings", () => {
    const rows = ParseCore.parseCSV("a,,c\n,2,\n");
    assert.deepEqual(rows, [
      ["a", "", "c"],
      ["", "2", ""],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* detectFormat                                                        */
/* ------------------------------------------------------------------ */

describe("detectFormat (content-first)", () => {
  test("SpreadsheetML detected by content even with a .txt name", () => {
    assert.equal(ParseCore.detectFormat("weird.txt", headOf(spreadsheetmlBytes())), "spreadsheetml");
  });

  test("SpreadsheetML detected with the real .xls name", () => {
    assert.equal(
      ParseCore.detectFormat("data-map-inventory.xls", headOf(spreadsheetmlBytes())),
      "spreadsheetml"
    );
  });

  test("xlsx detected by ZIP magic even with a misleading .csv name", () => {
    assert.equal(ParseCore.detectFormat("data.csv", headOf(xlsxBytes())), "xlsx");
  });

  test("legacy binary .xls detected by OLE signature", () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);
    assert.equal(ParseCore.detectFormat("old.xls", ole), "xls-binary");
  });

  test("plain text with .csv name is csv", () => {
    const text = Buffer.from("a,b\n1,2\n", "utf8");
    assert.equal(ParseCore.detectFormat("inventory.csv", headOf(text)), "csv");
  });

  test("extension alone is never trusted: .xlsx name with garbage bytes is unknown", () => {
    const garbage = Buffer.from("this is not a workbook at all", "utf8");
    assert.equal(ParseCore.detectFormat("fake.xlsx", headOf(garbage)), "unknown");
  });

  test("extension alone is never trusted: .xls name with garbage bytes is unknown", () => {
    const garbage = Buffer.from("this is not a workbook at all", "utf8");
    assert.equal(ParseCore.detectFormat("fake.xls", headOf(garbage)), "unknown");
  });

  test("random bytes with no useful name are unknown", () => {
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
    assert.equal(ParseCore.detectFormat("", headOf(garbage)), "unknown");
  });
});

/* ------------------------------------------------------------------ */
/* generated .xlsx round trip                                          */
/* ------------------------------------------------------------------ */

describe(".xlsx round trip via the vendored build", () => {
  test("detects, reads, and returns raw string rows with headers intact", () => {
    const buf = xlsxBytes();
    const res = ParseCore.parseFileBuffer(XLSX, buf, "template.xlsx");
    assert.equal(res.ok, true);
    assert.equal(res.format, "xlsx");
    assert.deepEqual(
      res.sheets.map((s) => s.name),
      ["Systems", "Data flows"]
    );
    const systems = res.sheets[0];
    assert.deepEqual(systems.rows[0], ["System / application name", "Type", "Since"]);
    assert.deepEqual(systems.rows[1], ["Shopify", "Third party", "2023-01-15"]);
    assert.deepEqual(systems.rows[2], ["Klaviyo", "Third party", "1234.5"]);
    assert.deepEqual(res.sheets[1].rows[0], ["From (system)", "To (system)", "Cross-border?"]);
    assert.deepEqual(res.sheets[1].rows[1], ["Shopify", "Klaviyo", "Yes"]);
  });
});

/* ------------------------------------------------------------------ */
/* SpreadsheetML exporter sample round trip                            */
/* ------------------------------------------------------------------ */

describe("SpreadsheetML exporter sample (freeze-doc shape)", () => {
  test("imports with zero mapping: disclaimer, blank, header rows preserved", () => {
    const res = ParseCore.parseFileBuffer(XLSX, spreadsheetmlBytes(), "data-map-inventory.xls");
    assert.equal(res.ok, true);
    assert.equal(res.format, "spreadsheetml");
    assert.deepEqual(
      res.sheets.map((s) => s.name),
      ["Nodes", "Connections"]
    );

    const nodes = res.sheets[0].rows;
    assert.ok(nodes[0][0].startsWith("DRAFT:"), "disclaimer row first");
    assert.deepEqual(nodes[1], ["", ""], "blank row second");
    assert.deepEqual(nodes[2], ["Label", "Type"], "header row third");
    assert.deepEqual(nodes[3], ["Checkout form", "Collection point"]);
    assert.deepEqual(nodes[5], ["Klaviyo", "Third party"]);

    const conns = res.sheets[1].rows;
    assert.deepEqual(conns[0], ["From", "To", "Category"]);
    assert.deepEqual(conns[1], ["Checkout form", "Shopify", "Contact / identity"]);
    assert.deepEqual(conns[2], ["Shopify", "Klaviyo", "Marketing / consent"]);
  });
});

/* ------------------------------------------------------------------ */
/* CSV through the full pipeline                                       */
/* ------------------------------------------------------------------ */

describe("CSV through parseFileBuffer", () => {
  test("first-class CSV: RFC-4180 parse, sheet named after the file", () => {
    const csv = Buffer.from('\uFEFFsystem,note\nAcme,"fast, cheap"\r\n', "utf8");
    const res = ParseCore.parseFileBuffer(XLSX, csv, "vendors.csv");
    assert.equal(res.ok, true);
    assert.equal(res.format, "csv");
    assert.equal(res.sheets[0].name, "vendors");
    assert.deepEqual(res.sheets[0].rows, [
      ["system", "note"],
      ["Acme", "fast, cheap"],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* rejection paths: plain-language errors, no em dashes                */
/* ------------------------------------------------------------------ */

describe("rejection paths", () => {
  test("unknown format is rejected with a plain-language error", () => {
    const garbage = Buffer.from("this is not a workbook at all", "utf8");
    const res = ParseCore.parseFileBuffer(XLSX, garbage, "notes.txt");
    assert.equal(res.ok, false);
    assert.ok(typeof res.error === "string" && res.error.length > 0);
    noEmDash(res.error);
    assert.ok(/\.xlsx/.test(res.error) && /\.csv/.test(res.error));
  });

  test("empty buffer is rejected with a plain-language error", () => {
    const res = ParseCore.parseFileBuffer(XLSX, new Uint8Array(0), "empty.csv");
    assert.equal(res.ok, false);
    noEmDash(res.error);
    assert.ok(/empty/i.test(res.error));
  });

  test("damaged xlsx is rejected with a plain-language error", () => {
    const bad = Buffer.from("PK\x03\x04damaged-zip-payload", "utf8");
    const res = ParseCore.parseFileBuffer(XLSX, bad, "broken.xlsx");
    assert.equal(res.ok, false);
    noEmDash(res.error);
    assert.ok(res.error.length > 0);
  });

  test("workbook with no readable content is rejected with a plain-language error", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "Empty");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const res = ParseCore.parseFileBuffer(XLSX, buf, "empty.xlsx");
    assert.equal(res.ok, false);
    noEmDash(res.error);
    assert.ok(/no sheets/i.test(res.error));
  });
});

/* ------------------------------------------------------------------ */
/* sheetsFromWorkbook contract                                         */
/* ------------------------------------------------------------------ */

describe("sheetsFromWorkbook contract", () => {
  test("returns raw string rows including the header row (no interpretation)", () => {
    const buf = xlsxBytes();
    const wb = ParseCore.readWorkbook(XLSX, buf, "xlsx", "template");
    const sheets = ParseCore.sheetsFromWorkbook(XLSX, wb);
    assert.ok(Array.isArray(sheets));
    for (const s of sheets) {
      assert.equal(typeof s.name, "string");
      assert.ok(Array.isArray(s.rows));
      for (const row of s.rows) {
        assert.ok(Array.isArray(row));
        for (const cell of row) assert.equal(typeof cell, "string");
      }
    }
  });
});
