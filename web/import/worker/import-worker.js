/* import-worker.js
 *
 * Web Worker for the AI-data-map Phase 1 import pipeline.
 *
 * No parsing ever runs on the main thread. The main thread posts
 * { buffer: ArrayBuffer, filename: string } (transferring the buffer) and
 * this worker posts back one of:
 *   { ok: true, format: "xlsx"|"xls-binary"|"spreadsheetml"|"csv",
 *     sheets: [{ name: string, rows: string[][] }] }
 *   { ok: false, error: "<plain-language message>" }
 *
 * sheets rows are RAW rows including the header row. Header detection and
 * column mapping belong to the engine worker, never here.
 *
 * importScripts paths resolve relative to THIS file's location. In the
 * committed web/import tree the layout is:
 *   web/import/worker/import-worker.js
 *   web/import/worker/parse-core.js
 *   web/import/vendor/xlsx.full.min.js
 * Same-origin local files only: this is what keeps the hash-based CSP
 * clean (no new script-src host, ever).
 */

importScripts("../vendor/xlsx.full.min.js", "parse-core.js");

self.onmessage = function (e) {
  var data = (e && e.data) || {};
  var result;
  try {
    // XLSX is the global exported by the vendored SheetJS build.
    result = self.ParseCore.parseFileBuffer(
      XLSX,
      data.buffer,
      data.filename || ""
    );
  } catch (err) {
    result = {
      ok: false,
      error:
        "Something went wrong while reading this file. Please try again, " +
        "or convert it to .csv and retry.",
    };
  }
  self.postMessage(result);
};
