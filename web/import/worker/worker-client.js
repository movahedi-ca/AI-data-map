/* worker-client.js
 *
 * Main-thread wrapper for import-worker.js.
 *
 *   ImportClient.parseFile(file, workerScriptUrl) -> Promise<sheets>
 *
 * Spawns the worker, transfers the file's ArrayBuffer to it, and terminates
 * the worker as soon as the result (or an error) comes back. Rejections
 * carry plain-language Error messages, no em dashes.
 *
 * workerScriptUrl is the same-origin URL of import-worker.js, e.g.
 * "import-worker.js" relative to the page, or the site's asset path once
 * deployed. The worker loads parse-core.js and the vendored SheetJS build
 * from paths relative to itself.
 */

(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.ImportClient = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var TIMEOUT_MS = 60000;

  function parseFile(file, workerScriptUrl) {
    return new Promise(function (resolve, reject) {
      var worker;
      try {
        worker = new Worker(workerScriptUrl);
      } catch (e) {
        reject(
          new Error(
            "The file reader could not start in this browser. Please try a " +
              "recent version of Chrome, Edge, Firefox, or Safari."
          )
        );
        return;
      }

      function cleanup() {
        try {
          worker.terminate();
        } catch (e) {
          /* already gone */
        }
      }

      var timer = setTimeout(function () {
        cleanup();
        reject(
          new Error(
            "Reading this file is taking too long. Please try a smaller file."
          )
        );
      }, TIMEOUT_MS);

      worker.onmessage = function (e) {
        clearTimeout(timer);
        cleanup();
        var d = (e && e.data) || {};
        if (d.ok) {
          resolve(d.sheets);
        } else {
          reject(new Error(d.error || "We could not read this file."));
        }
      };

      worker.onerror = function () {
        clearTimeout(timer);
        cleanup();
        reject(
          new Error("The file reader hit a problem and stopped. Please try again.")
        );
      };

      file
        .arrayBuffer()
        .then(function (buf) {
          worker.postMessage({ buffer: buf, filename: file.name || "" }, [buf]);
        })
        .catch(function () {
          clearTimeout(timer);
          cleanup();
          reject(
            new Error("We could not read this file from your device. Please try again.")
          );
        });
    });
  }

  return { parseFile: parseFile };
});
