/* scenarios/common.mjs - shared browser steps for the import teacher scenarios.
 *
 * Thin helpers over the mcp-client: gate acceptance, bounded waits, chunked
 * file upload, the applyState capture hook, sheet picking, and review-state
 * reading. Polling loops are bounded by iteration count, never by wall-clock
 * time, so runs stay deterministic.
 */

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* Accept the builder gate. A repeat visit in the same browser session finds
 * the gate already open via sessionStorage and skips the clicks. */
export async function acceptGate(client) {
  const st = await client.evalJson(
    "JSON.stringify({ appHidden: document.getElementById('builder-app').hidden })"
  );
  if (st.appHidden === false) return;
  await client.callTool("click", { selector: "#gate-check" });
  await client.callTool("click", { selector: "#gate-open" });
  await waitStep(client, "builder-app");
}

/* Poll until the import step with the given id is visible. Bounded loop:
 * throws loudly on timeout so a stall can never read stale DOM. */
export async function waitStep(client, id, tries) {
  const limit = tries || 150;
  for (let i = 0; i < limit; i++) {
    const st = await client.evalJson(
      "JSON.stringify({ hidden: document.getElementById('" + id + "').hidden })"
    );
    if (st.hidden === false) return;
    await sleep(200);
  }
  throw new Error("timeout waiting for step visible: " + id);
}

/* Push a file through the real #imp-file input. The bytes travel as base64
 * in chunks (the evaluate tool caps scripts at 20000 chars), then a File is
 * built in the page and a change event is dispatched, exactly like a user
 * picking the file. */
export async function uploadFile(client, fileName, mime, bytes) {
  const b64 = bytes.toString("base64");
  const CHUNK = 6000;
  await client.evalRaw("window.__upchunks = [];");
  for (let i = 0; i < b64.length; i += CHUNK) {
    await client.evalRaw("window.__upchunks.push('" + b64.slice(i, i + CHUNK) + "');");
  }
  const res = await client.evalRaw(
    "(function () {" +
      "var b64 = window.__upchunks.join(''); window.__upchunks = [];" +
      "var bin = atob(b64);" +
      "var arr = new Uint8Array(bin.length);" +
      "for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);" +
      "var file = new File([arr], " +
      JSON.stringify(fileName) +
      ", { type: " +
      JSON.stringify(mime) +
      " });" +
      "var dt = new DataTransfer(); dt.items.add(file);" +
      "var input = document.getElementById('imp-file');" +
      "input.files = dt.files;" +
      "input.dispatchEvent(new Event('change', { bubbles: true }));" +
      "return 'dispatched';" +
      "})()"
  );
  if (res.indexOf("dispatched") === -1) {
    throw new Error("upload dispatch failed: " + res);
  }
}

/* Wrap window.DMImport.applyState so the exact state the import builds is
 * captured. The wrapper is installed after page load; import.js looks the
 * hook up at build time, so the wrapped version is what runs. */
export async function installApplyHook(client) {
  const res = await client.evalRaw(
    "(function () {" +
      "window.__appliedStates = [];" +
      "var hook = window.DMImport && window.DMImport.applyState;" +
      "if (typeof hook !== 'function') return 'no-hook';" +
      "window.DMImport.applyState = function (state) {" +
      "window.__appliedStates.push(JSON.parse(JSON.stringify(state || {})));" +
      "return hook(state);" +
      "};" +
      "return 'hooked';" +
      "})()"
  );
  if (res.indexOf("hooked") === -1) {
    throw new Error("applyState hook install failed: " + res);
  }
}

export async function readAppliedState(client) {
  const st = await client.evalJson("JSON.stringify({ states: window.__appliedStates || [] })");
  if (!st.states.length) throw new Error("applyState was never called by the page");
  return st.states[st.states.length - 1];
}

/* Pick the systems/flows sheets whose option labels contain the given
 * needles. Exactly one enabled match each, or a loud failure. */
export async function pickSheets(client, sysNeedle, flowsNeedle) {
  const opts = await client.evalJson(
    "JSON.stringify({" +
      "sys: [...document.getElementById('imp-sys-sheet').options].map(o => " +
      "({ value: o.value, text: o.text, disabled: o.disabled }))," +
      "flows: [...document.getElementById('imp-flows-sheet').options].map(o => " +
      "({ value: o.value, text: o.text, disabled: o.disabled }))" +
      "})"
  );
  const sys = opts.sys.filter((o) => !o.disabled && o.text.indexOf(sysNeedle) !== -1);
  const flows = opts.flows.filter((o) => !o.disabled && o.text.indexOf(flowsNeedle) !== -1);
  if (sys.length !== 1) {
    throw new Error("expected 1 systems sheet matching '" + sysNeedle + "', got " + sys.length);
  }
  if (flows.length !== 1) {
    throw new Error("expected 1 flows sheet matching '" + flowsNeedle + "', got " + flows.length);
  }
  await client.evalRaw(
    "(function () {" +
      "document.getElementById('imp-sys-sheet').value = " +
      JSON.stringify(sys[0].value) +
      ";" +
      "document.getElementById('imp-flows-sheet').value = " +
      JSON.stringify(flows[0].value) +
      ";" +
      "return 'set';" +
      "})()"
  );
  return { sysText: sys[0].text, flowsText: flows[0].text };
}

/* Column-mapping guesses the page prefilled: [{id, value}]. */
export async function mappingGuesses(client) {
  return client.evalJson(
    "JSON.stringify(" +
      "[...document.querySelectorAll('#imp-map-body select')].map(s => ({ id: s.id, value: s.value }))" +
      ")"
  );
}

/* Review-step state: system rows, flow rows (chosen category + badge + note),
 * inline flags, skipped rows, build-button state. Same shape as the Phase 1
 * qa-accept REVIEW_STATE probe. */
const REVIEW_STATE_SCRIPT = `JSON.stringify((() => {
  const body = document.getElementById('imp-review-body');
  const sysRows = [], flowRows = [], flags = [];
  [...body.querySelectorAll('table.imp-table')].forEach(t => {
    [...t.rows].forEach((tr, ri) => {
      if (ri === 0) return;
      const flagTd = tr.querySelector('td.imp-flag');
      if (flagTd) { flags.push({ cls: flagTd.className, text: flagTd.textContent.trim().slice(0, 300) }); return; }
      const cells = [...tr.cells].map(c => c.textContent.trim());
      if (cells.length === 3) sysRows.push({ name: cells[0], type: cells[1], row: cells[2] });
      else if (cells.length === 5) {
        const sel = tr.querySelector('select');
        flowRows.push({
          from: cells[0], to: cells[1], data: cells[2].slice(0, 60), row: cells[3],
          cat: sel ? sel.value : null,
          badge: (tr.querySelector('.imp-badge') || { textContent: '' }).textContent,
          note: (tr.querySelector('.imp-note') || { textContent: '' }).textContent.slice(0, 200)
        });
      }
    });
  });
  const skipped = [...body.querySelectorAll('.imp-skipped li')].map(li => li.textContent.trim().slice(0, 300));
  return { sysRows, flowRows, flags, skipped,
    buildDisabled: document.getElementById('imp-build').disabled };
})())`;

export async function reviewState(client) {
  return client.evalJson(REVIEW_STATE_SCRIPT);
}

/* Click the page's Excel export button and confirm a download actually
 * fires. Wraps URL.createObjectURL to capture the blob the page hands to
 * the browser. Returns { type, size }. */
export async function confirmExportDownload(client) {
  await client.evalRaw(
    "(function () {" +
      "window.__dlBlobs = [];" +
      "var orig = URL.createObjectURL.bind(URL);" +
      "URL.createObjectURL = function (blob) {" +
      "try { window.__dlBlobs.push(blob); } catch (e) {}" +
      "return orig(blob);" +
      "};" +
      "return 'wrapped';" +
      "})()"
  );
  await client.callTool("click", { selector: "#bn-xls" });
  for (let i = 0; i < 50; i++) {
    const n = await client.evalJson("JSON.stringify({ n: (window.__dlBlobs || []).length })");
    if (n.n > 0) break;
    if (i === 49) throw new Error("export download did not fire after clicking #bn-xls");
    await sleep(200);
  }
  const info = await client.evalJson(
    "(async () => {" +
      "const b = window.__dlBlobs[0];" +
      "return JSON.stringify({ type: b.type, size: b.size });" +
      "})()"
  );
  if (!info.type || info.size <= 0) {
    throw new Error("export produced an empty blob: " + JSON.stringify(info));
  }
  return info;
}
