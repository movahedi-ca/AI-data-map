/* parse-core.js
 *
 * DOM-free parsing primitives for the AI-data-map Phase 1 import pipeline.
 * Runs in the Web Worker (import-worker.js) and imports cleanly in Node for
 * testing. No Worker, DOM, or window references anywhere in this file.
 *
 * Exports:
 *   parseCSV(text)                        -> string[][]
 *   detectFormat(filename, headBytes)     -> "xlsx" | "xls-binary" |
 *                                            "spreadsheetml" | "csv" | "unknown"
 *   sheetsFromWorkbook(XLSX, wb)          -> [{ name, rows: string[][] }]
 *   readWorkbook(XLSX, buffer, format, sheetName) -> SheetJS workbook object
 *   parseFileBuffer(XLSX, buffer, filename) -> { ok: true, format, sheets } |
 *                                              { ok: false, error }
 *
 * Contract with the engine worker: sheets arrive as [{ name, rows }] where
 * rows are RAW string rows including the header row. Header detection and
 * column mapping belong to the engine, never here.
 */

(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.ParseCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SPREADSHEET_NS = "urn:schemas-microsoft-com:office:spreadsheet";
  var OLE_SIG = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  var SNIFF_LEN = 8192;

  /* ------------------------------------------------------------------ */
  /* byte helpers                                                        */
  /* ------------------------------------------------------------------ */

  function toBytes(head) {
    if (head instanceof Uint8Array) return head;
    if (typeof ArrayBuffer !== "undefined" && head instanceof ArrayBuffer) {
      return new Uint8Array(head);
    }
    if (typeof head === "string") {
      var b = new Uint8Array(head.length);
      for (var i = 0; i < head.length; i++) b[i] = head.charCodeAt(i) & 0xff;
      return b;
    }
    return new Uint8Array(0);
  }

  // Latin-1 decode: ASCII-safe, enough for magic-byte and namespace sniffing.
  function latin1(bytes) {
    var out = "";
    var CHUNK = 8192;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return out;
  }

  function decodeUTF8(buffer) {
    var bytes = toBytes(buffer);
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder("utf-8").decode(bytes);
    }
    return latin1(bytes);
  }

  function byteLengthOf(buffer) {
    if (!buffer) return 0;
    if (typeof buffer.byteLength === "number") return buffer.byteLength;
    if (typeof buffer.length === "number") return buffer.length;
    return 0;
  }

  /* ------------------------------------------------------------------ */
  /* parseCSV: first-class RFC-4180 CSV                                  */
  /* ------------------------------------------------------------------ */
  // Quoted fields, embedded commas/newlines, doubled-quote escapes, CRLF
  // and LF line endings, UTF-8 BOM strip. Returns rows as string[][].

  function parseCSV(text) {
    if (text == null) return [];
    text = String(text);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text.length === 0) return [];

    var rows = [];
    var row = [];
    var field = "";
    var i = 0;
    var n = text.length;
    var inQuotes = false;

    function endRow() {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    }

    while (i < n) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (i + 1 < n && text[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            inQuotes = false;
            i++;
          }
        } else {
          field += c;
          i++;
        }
      } else if (c === '"') {
        inQuotes = true;
        i++;
      } else if (c === ",") {
        row.push(field);
        field = "";
        i++;
      } else if (c === "\r") {
        endRow();
        i += i + 1 < n && text[i + 1] === "\n" ? 2 : 1;
      } else if (c === "\n") {
        endRow();
        i++;
      } else {
        field += c;
        i++;
      }
    }
    row.push(field);
    rows.push(row);

    // A single trailing newline leaves one phantom empty row; drop it.
    var last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "" && /[\r\n]$/.test(text)) {
      rows.pop();
    }

    return rows;
  }

  /* ------------------------------------------------------------------ */
  /* detectFormat: content-first, extension only as a tiebreaker          */
  /* ------------------------------------------------------------------ */

  function detectFormat(filename, head) {
    var bytes = toBytes(head);
    var name = String(filename || "").toLowerCase();
    var dot = name.lastIndexOf(".");
    var ext = dot === -1 ? "" : name.slice(dot);

    // Skip a UTF-8 BOM for sniffing purposes.
    var start = 0;
    if (
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf
    ) {
      start = 3;
    }

    var text = latin1(bytes.subarray(start, Math.min(bytes.length, start + SNIFF_LEN)));
    var trimmed = text.replace(/^\s+/, "");

    // The site's own .xls exporter writes SpreadsheetML 2003 XML with a BOM.
    // Detect by content: optional BOM/whitespace, then <?xml, and the
    // SpreadsheetML namespace must be present.
    if (
      trimmed.slice(0, 5) === "<?xml" &&
      trimmed.indexOf(SPREADSHEET_NS) !== -1
    ) {
      return "spreadsheetml";
    }
    // SpreadsheetML without the XML declaration (defensive).
    if (
      trimmed.slice(0, 9) === "<Workbook" &&
      trimmed.indexOf(SPREADSHEET_NS) !== -1
    ) {
      return "spreadsheetml";
    }

    // ZIP magic: modern .xlsx/.xlsm workbooks are ZIP archives.
    if (bytes.length - start >= 2 && bytes[start] === 0x50 && bytes[start + 1] === 0x4b) {
      return "xlsx";
    }

    // OLE compound-document magic: legacy binary .xls.
    if (bytes.length - start >= 8) {
      var ole = true;
      for (var i = 0; i < 8; i++) {
        if (bytes[start + i] !== OLE_SIG[i]) {
          ole = false;
          break;
        }
      }
      if (ole) return "xls-binary";
    }

    // Extension is only a tiebreaker: CSV has no magic bytes, so a .csv
    // extension is the only way to claim CSV for otherwise plain text.
    if (ext === ".csv") return "csv";

    return "unknown";
  }

  /* ------------------------------------------------------------------ */
  /* workbook conversion                                                 */
  /* ------------------------------------------------------------------ */

  function baseName(filename) {
    var n = String(filename || "").split(/[\\/]/).pop();
    var dot = n.lastIndexOf(".");
    var base = dot > 0 ? n.slice(0, dot) : n;
    return base || "Sheet1";
  }

  // raw:false => formatted text, so dates and numbers arrive as displayed strings.
  function sheetsFromWorkbook(XLSX, wb) {
    var names = wb.SheetNames || [];
    return names.map(function (name) {
      var aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], {
        header: 1,
        defval: "",
        raw: false,
      });
      var rows = (aoa || []).map(function (r) {
        var arr = Array.isArray(r) ? r : [];
        return arr.map(function (v) {
          return v == null ? "" : String(v);
        });
      });
      return { name: name, rows: rows };
    });
  }

  function readWorkbook(XLSX, buffer, format, sheetName) {
    if (format === "csv") {
      // CSV is first-class: our own RFC-4180 parser, not SheetJS's.
      var wb = XLSX.utils.book_new();
      var ws = XLSX.utils.aoa_to_sheet(parseCSV(decodeUTF8(buffer)));
      XLSX.utils.book_append_sheet(wb, ws, sheetName || "Sheet1");
      return wb;
    }
    if (format === "spreadsheetml") {
      return XLSX.read(decodeUTF8(buffer), { type: "string" });
    }
    return XLSX.read(toBytes(buffer), { type: "array" });
  }

  /* ------------------------------------------------------------------ */
  /* parseFileBuffer: the full pipeline in one call                       */
  /* ------------------------------------------------------------------ */

  var ERR_UNKNOWN =
    "We could not open this file. It reads .xlsx, .xls, and .csv files. " +
    "Please convert your file to one of those formats and try again.";
  var ERR_EMPTY =
    "This file is empty. Please choose a file with content and try again.";
  var ERR_NO_SHEETS =
    "This file has no sheets with content to import. Please check the file and try again.";
  var ERR_READ =
    "We could not read this file. It may be damaged, password protected, or " +
    "saved in a format we do not recognize yet. Please try another file.";

  function parseFileBuffer(XLSX, buffer, filename) {
    if (!buffer || byteLengthOf(buffer) === 0) {
      return { ok: false, error: ERR_EMPTY };
    }
    var view = toBytes(buffer);
    var head = view.subarray(0, Math.min(view.length, SNIFF_LEN));
    var format = detectFormat(filename, head);
    if (format === "unknown") {
      return { ok: false, error: ERR_UNKNOWN };
    }
    var wb;
    try {
      wb = readWorkbook(XLSX, buffer, format, baseName(filename));
    } catch (e) {
      return { ok: false, error: ERR_READ };
    }
    var sheets;
    try {
      sheets = sheetsFromWorkbook(XLSX, wb);
    } catch (e) {
      return { ok: false, error: ERR_READ };
    }
    var hasContent = sheets.some(function (s) {
      return s.rows.length > 0;
    });
    if (!hasContent) {
      return { ok: false, error: ERR_NO_SHEETS };
    }
    return { ok: true, format: format, sheets: sheets };
  }

  return {
    parseCSV: parseCSV,
    detectFormat: detectFormat,
    sheetsFromWorkbook: sheetsFromWorkbook,
    readWorkbook: readWorkbook,
    parseFileBuffer: parseFileBuffer,
  };
});
