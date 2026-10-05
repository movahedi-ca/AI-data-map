#!/usr/bin/env node
/* tools/qa-accept.mjs — Phase 1 acceptance run (verification worker).
 *
 * Serves nothing itself; expects `python3 -m http.server 8123` from ui/.
 * Drives the localhost-qa MCP server over stdio and executes the acceptance
 * criteria for real in the browser:
 *   A. load EN page, accept the T&C gate
 *   B. real template EXAMPLE sheet in -> map out on the canvas
 *   C. capture the page's own .xls download, parse the SpreadsheetML
 *   D. feed the captured .xls back (round-trip: zero mapping step)
 *   E. deliberately broken file -> inline flags, nothing silently guessed
 *   F. CSV path + FR page
 *   G. hygiene: console clean, zero failed requests, zero third-party scripts
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SERVER = path.resolve(process.env.HOME + "/workspace/skills/localhost-qa/src/server.js");
const BASE = "http://127.0.0.1:8123/site-demo";
const SHOT_DIR = path.resolve("qa-shots");
fs.mkdirSync(SHOT_DIR, { recursive: true });

const child = spawn("node", [SERVER], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, CHROME_NO_SANDBOX: "1" },
});

let buf = "";
let nextId = 1;
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}
async function callTool(name, args) {
  const res = await send("tools/call", { name, arguments: args || {} });
  if (res.error) throw new Error("tool " + name + " failed: " + JSON.stringify(res.error));
  const c = (res.result && res.result.content) || [];
  return c.map((x) => x.text || "").join("\n");
}
function textOf(t) {
  try { return JSON.parse(t); } catch { return t; }
}
// evaluate() results come back double-encoded.
async function evalJson(script) {
  const text = await callTool("evaluate", { script });
  return JSON.parse(JSON.parse(text));
}
async function evalRaw(script) {
  return await callTool("evaluate", { script });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || "" });
  console.log((cond ? "PASS" : "FAIL") + " - " + name + (detail ? " :: " + detail : ""));
}
async function shot(name, width) {
  const args = width ? { width } : {};
  const res = await send("tools/call", { name: "screenshot", arguments: args });
  const c = (res.result && res.result.content) || [];
  const img = c.find((x) => x.type === "image");
  if (img && img.data) {
    const p = path.join(SHOT_DIR, name + ".png");
    fs.writeFileSync(p, Buffer.from(img.data, "base64"));
    console.log("shot: " + p);
  }
}
async function hygiene(tag) {
  const errs = textOf(await callTool("console", {}));
  const net = textOf(await callTool("network", {}));
  check(tag + ": console clean", Array.isArray(errs) && errs.length === 0, JSON.stringify(errs).slice(0, 400));
  check(tag + ": no failed requests", Array.isArray(net) && net.length === 0, JSON.stringify(net).slice(0, 400));
}

// Upload a served file through the real file input.
function uploadScript(urlPath, fileName, mime) {
  return `(async () => {
    const res = await fetch('${urlPath}');
    const buf = await res.arrayBuffer();
    const file = new File([buf], '${fileName}', { type: '${mime}' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('imp-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'dispatched';
  })()`;
}

// Canvas state: nodes (type/label/position) + edges (cat + resolved from/to labels).
const CANVAS_STATE = `JSON.stringify((() => {
  const svg = document.getElementById('builder-canvas');
  const nodes = [...svg.querySelectorAll('[data-node]')].map(g => {
    const aria = g.getAttribute('aria-label') || '';
    const m = aria.match(/^([^:]+): (.*)$/);
    const tr = g.getAttribute('transform') || '';
    const tm = tr.match(/translate\\(([\\d.]+),\\s*([\\d.]+)\\)/);
    return { type: m ? m[1] : aria, label: m ? m[2] : '', x: tm ? +tm[1] : 0, y: tm ? +tm[2] : 0 };
  });
  const edges = [...svg.querySelectorAll('.edge')].map(p => {
    const nums = (p.getAttribute('d') || '').match(/[\\d.]+/g).map(Number);
    const cls = (p.getAttribute('class') || '').split(/\\s+/).filter(c => c !== 'edge');
    const mx = nums[0], my = nums[1], lx = nums[2], ly = nums[3];
    const len = Math.hypot(lx - mx, ly - my) || 1;
    const ux = (lx - mx) / len, uy = (ly - my) / len;
    const near = (x, y) => {
      let best = null, bd = 1e9;
      for (const n of nodes) { const dd = Math.hypot(n.x - x, n.y - y); if (dd < bd) { bd = dd; best = n; } }
      return bd < 2 ? best.label : null;
    };
    return { cat: cls[0] || '', from: near(mx - ux * 28, my - uy * 28), to: near(lx + ux * 32, ly + uy * 32) };
  });
  return { nodes, edges, status: document.getElementById('builder-status').textContent };
})())`;

// Review-step state: system rows, flow rows (with chosen category + badge),
// inline flags, skipped rows, build-button state.
const REVIEW_STATE = `JSON.stringify((() => {
  const body = document.getElementById('imp-review-body');
  const sysRows = [], flowRows = [], flags = [];
  [...body.querySelectorAll('table.imp-table')].forEach(t => {
    [...t.rows].forEach((tr, ri) => {
      if (ri === 0) return;
      const flagTd = tr.querySelector('td.imp-flag');
      if (flagTd) { flags.push({ cls: flagTd.className, text: flagTd.textContent.trim().slice(0, 220) }); return; }
      const cells = [...tr.cells].map(c => c.textContent.trim());
      if (cells.length === 3) sysRows.push({ name: cells[0], type: cells[1], row: cells[2] });
      else if (cells.length === 5) {
        const sel = tr.querySelector('select');
        flowRows.push({
          from: cells[0], to: cells[1], data: cells[2].slice(0, 60), row: cells[3],
          cat: sel ? sel.value : null,
          badge: (tr.querySelector('.imp-badge') || { textContent: '' }).textContent,
          note: (tr.querySelector('.imp-note') || { textContent: '' }).textContent.slice(0, 160)
        });
      }
    });
  });
  const skipped = [...body.querySelectorAll('.imp-skipped li')].map(li => li.textContent.trim().slice(0, 220));
  const done = document.getElementById('imp-done-body').textContent;
  return { sysRows, flowRows, flags, skipped, buildDisabled: document.getElementById('imp-build').disabled, done: done.slice(0, 200) };
})())`;

const SCRIPTS_OFF_ORIGIN = `JSON.stringify(
  [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src'))
)`;

async function acceptGate() {
  await callTool("click", { selector: "#gate-check" });
  await callTool("click", { selector: "#gate-open" });
  await waitStep("builder-app");
  await waitStep("imp-sec");
}

// wait_for's default timeout is 5s and a timeout is NOT an exception here;
// the first worker parse (cold) can take longer. Poll page state instead and
// throw loudly on timeout so a stall can never read stale DOM.
async function waitStep(id, timeoutMs) {
  const t0 = Date.now();
  const limit = timeoutMs || 30000;
  for (;;) {
    const st = await evalJson(`JSON.stringify({ hidden: document.getElementById('${id}').hidden })`);
    if (st.hidden === false) return;
    if (Date.now() - t0 > limit) throw new Error("timeout waiting for step visible: " + id);
    await new Promise((r) => setTimeout(r, 200));
  }
}
async function waitPickerOptions(timeoutMs) {
  const t0 = Date.now();
  const limit = timeoutMs || 30000;
  for (;;) {
    const st = await evalJson("JSON.stringify({ n: document.getElementById('imp-sys-sheet').options.length })");
    if (st.n > 0) return;
    if (Date.now() - t0 > limit) throw new Error("timeout waiting for sheet picker options");
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "qa-accept", version: "1" },
  });
  notify("notifications/initialized", {});

  // ================= A. load + gate =================
  console.log("== A: load + gate ==");
  await callTool("navigate", { url: BASE + "/index.html" });
  await acceptGate();
  const gateOk = await evalJson(
    "JSON.stringify({ appHidden: document.getElementById('builder-app').hidden, hasHook: typeof (window.DMImport && window.DMImport.applyState) })"
  );
  check("A: gate opens builder app, import section present, hook installed",
    gateOk.appHidden === false && gateOk.hasHook === "function", JSON.stringify(gateOk));
  await hygiene("A");

  // ================= B. real template EXAMPLE sheet in -> map out =================
  console.log("== B: EXAMPLE 2 (stacked sheet) -> map ==");
  await evalRaw(uploadScript("/accept-tmp/example2-saas.xlsx", "example2-saas.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
  await waitStep("imp-step-sheets");
  await waitPickerOptions();
  const picker = await evalJson(`JSON.stringify({
    sys: document.getElementById('imp-sys-sheet').value,
    flows: document.getElementById('imp-flows-sheet').value,
    sysOpts: [...document.getElementById('imp-sys-sheet').options].map(o => o.text),
    flowsOpts: [...document.getElementById('imp-flows-sheet').options].map(o => o.text)
  })`);
  console.log("picker:", JSON.stringify(picker.sysOpts));
  check("B: stacked sheet split into (Systems)+(Data flows) picker entries",
    picker.sysOpts.length === 2 && picker.sysOpts[0].indexOf("(Systems)") !== -1 &&
    picker.flowsOpts[1].indexOf("(Data flows)") !== -1, JSON.stringify(picker.sysOpts));
  check("B: picker defaults to the split sections",
    picker.sys === "0" && picker.flows === "1", "sys=" + picker.sys + " flows=" + picker.flows);
  await shot("accept-01-picker");

  await callTool("click", { selector: "#imp-sheets-next" });
  await waitStep("imp-step-map");
  const mapState = await evalJson(
    "JSON.stringify({ selects: [...document.querySelectorAll('#imp-map-body select')].map(s => s.id + '=' + s.value) })"
  );
  check("B: mapping step shows 17 prefilled guesses (9 systems + 8 flows fields)",
    mapState.selects.length === 17 && mapState.selects[0] === "imp-map-0-systemName=0" &&
    mapState.selects[9] === "imp-map-1-from=0",
    "n=" + mapState.selects.length + " first=" + mapState.selects[0]);
  await shot("accept-02-mapping");

  await callTool("click", { selector: "#imp-map-next" });
  await waitStep("imp-step-review");
  const rev = await evalJson(REVIEW_STATE);
  console.log("review systems:", rev.sysRows.length, "flows:", rev.flowRows.length);
  check("B: review lists 7 systems", rev.sysRows.length === 7,
    rev.sysRows.map(r => r.name).join(" | ").slice(0, 200));
  check("B: review lists 5 flows", rev.flowRows.length === 5);
  const cats = rev.flowRows.map(f => f.cat);
  check("B: categories proposed contact/payment/marketing/contact/contact",
    JSON.stringify(cats) === JSON.stringify(["contact", "payment", "marketing", "contact", "contact"]),
    JSON.stringify(cats));
  check("B: every proposal badged Suggested (explicit, never silent)",
    rev.flowRows.every(f => f.badge === "Suggested"), rev.flowRows.map(f => f.badge).join(","));
  check("B: payment proposal cites its keyword reason",
    (rev.flowRows[1].note || "").indexOf("payment") !== -1, rev.flowRows[1].note);
  check("B: flags are exactly the 5 expected MISSING_CATEGORY warnings (suggestion awaiting confirmation), no errors",
    rev.flags.length === 5 && rev.flags.every(f =>
      f.cls.indexOf("imp-flag-warning") !== -1 && f.text.indexOf("suggested category") !== -1),
    rev.flags.length + " flags");
  check("B: build enabled with all categories proposed", rev.buildDisabled === false);
  await shot("accept-03-review");

  await callTool("click", { selector: "#imp-build" });
  await waitStep("imp-step-done");
  const cs = await evalJson(CANVAS_STATE);
  const nodeLabels = cs.nodes.map(n => n.label).sort();
  const expNodes = ["Google Workspace", "HubSpot", "Intercom", "Iron Mountain (backups)",
    "PostgreSQL (AWS ca-central-1)", "Signup form (app)", "Stripe"].sort();
  check("B: canvas shows the 7 expected nodes", JSON.stringify(nodeLabels) === JSON.stringify(expNodes),
    nodeLabels.join(" | "));
  const nodeTypes = {};
  cs.nodes.forEach(n => { nodeTypes[n.label] = n.type; });
  check("B: node types correct (collection/system/thirdparty)",
    nodeTypes["Signup form (app)"] === "collection" && nodeTypes["Stripe"] === "thirdparty" &&
    nodeTypes["PostgreSQL (AWS ca-central-1)"] === "system" && nodeTypes["Google Workspace"] === "system",
    JSON.stringify(nodeTypes));
  const expEdges = [
    ["Signup form (app)", "PostgreSQL (AWS ca-central-1)", "contact"],
    ["PostgreSQL (AWS ca-central-1)", "Stripe", "payment"],
    ["PostgreSQL (AWS ca-central-1)", "HubSpot", "marketing"],
    ["Signup form (app)", "Intercom", "contact"],
    ["PostgreSQL (AWS ca-central-1)", "Iron Mountain (backups)", "contact"],
  ];
  const gotEdges = cs.edges.map(e => [e.from, e.to, e.cat]);
  check("B: canvas shows the 5 expected edges with categories",
    JSON.stringify(gotEdges) === JSON.stringify(expEdges), JSON.stringify(gotEdges));
  check("B: status confirms the import", (cs.status || "").indexOf("Imported map") !== -1, cs.status);
  const doneB = await evalJson("JSON.stringify(document.getElementById('imp-done-body').textContent)");
  check("B: done summary counts 7 systems, 5 connections, 0 skipped",
    doneB.indexOf("7 systems placed, 5 connections drawn, 0 rows skipped") !== -1, doneB.slice(0, 120));
  await shot("accept-04-map", 1280);
  await hygiene("B");

  // ================= C. capture the page's own .xls download =================
  console.log("== C: download capture ==");
  await evalRaw(`(() => {
    window.__xlsBlobs = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) {
      try { window.__xlsBlobs.push(blob); } catch (e) {}
      return orig(blob);
    };
    return 'wrapped';
  })()`);
  await callTool("click", { selector: "#bn-xls" });
  const cap = await evalJson(`(async () => {
    const b = (window.__xlsBlobs || [])[0];
    if (!b) return JSON.stringify({ error: 'no blob captured' });
    const text = await b.text();
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const sheets = [...doc.getElementsByTagName('Worksheet')].map(ws => ({
      name: ws.getAttribute('ss:Name'),
      rows: [...ws.getElementsByTagName('Row')].map(r =>
        [...r.getElementsByTagName('Data')].map(d => d.textContent))
    }));
    return JSON.stringify({ type: b.type, size: b.size, sheets });
  })()`);
  check("C: one .xls blob produced client-side", !cap.error && cap.sheets.length === 2,
    cap.error || ("type=" + cap.type + " size=" + cap.size));
  check("C: blob is the Excel MIME type", (cap.type || "").indexOf("ms-excel") !== -1, cap.type);
  const nodesSheet = cap.sheets[0], connsSheet = cap.sheets[1];
  check("C: sheets named Nodes + Connections", nodesSheet.name === "Nodes" && connsSheet.name === "Connections",
    nodesSheet.name + "/" + connsSheet.name);
  check("C: Nodes sheet has framing rows then the header (freeze order: disclaimer, blank, header)",
    nodesSheet.rows[0].length === 1 && nodesSheet.rows[0][0].toLowerCase().indexOf("legal advice") !== -1 &&
    nodesSheet.rows[1].length === 1 && nodesSheet.rows[1][0] === "" &&
    JSON.stringify(nodesSheet.rows[2]) === JSON.stringify(["Label", "Type"]),
    JSON.stringify(nodesSheet.rows.slice(0, 3).map(r => r.length)));
  const xlsNodes = nodesSheet.rows.slice(3);
  const xlsNodeLabels = xlsNodes.map(r => r[0]).sort();
  check("C: Nodes sheet lists the 7 built nodes", JSON.stringify(xlsNodeLabels) === JSON.stringify(expNodes),
    xlsNodeLabels.join(" | "));
  const xlsTypes = {};
  xlsNodes.forEach(r => { xlsTypes[r[0]] = r[1]; });
  check("C: Nodes sheet types are display names",
    xlsTypes["Signup form (app)"] === "Collection point" && xlsTypes["Stripe"] === "Third party" &&
    xlsTypes["PostgreSQL (AWS ca-central-1)"] === "System", JSON.stringify(xlsTypes).slice(0, 200));
  check("C: Connections sheet header", JSON.stringify(connsSheet.rows[0]) === JSON.stringify(["From", "To", "Category"]),
    JSON.stringify(connsSheet.rows[0]));
  const xlsEdges = connsSheet.rows.slice(1).map(r => [r[0], r[1],
    r[2] === "Contact / identity" ? "contact" : r[2] === "Payment" ? "payment" : r[2] === "Marketing / consent" ? "marketing" : r[2]]);
  check("C: Connections sheet matches the 5 built edges",
    JSON.stringify(xlsEdges) === JSON.stringify(expEdges), JSON.stringify(xlsEdges));
  const xlsText = await evalJson(`(async () => {
    const b = (window.__xlsBlobs || [])[0];
    return JSON.stringify(await b.text());
  })()`);
  await hygiene("C");

  // ================= D. round-trip: the captured .xls back in =================
  console.log("== D: round-trip ==");
  await callTool("click", { selector: "#imp-again" });
  await waitStep("imp-step-file");
  await evalRaw(`(async () => {
    const xml = ${JSON.stringify(xlsText)};
    const file = new File([xml], 'data-map-inventory.xls', { type: 'application/vnd.ms-excel' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('imp-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'dispatched';
  })()`);
  // The export has two sheets (Nodes + Connections), so the picker appears;
  // the MAPPING step must still be skipped entirely.
  await waitStep("imp-step-sheets");
  const rtPicker = await evalJson(`JSON.stringify({
    sysOpts: [...document.getElementById('imp-sys-sheet').options].map(o => o.text),
    flowsOpts: [...document.getElementById('imp-flows-sheet').options].map(o => o.text)
  })`);
  check("D: round-trip picker offers the Nodes and Connections sheets",
    rtPicker.sysOpts.some(o => o.indexOf("Nodes") !== -1) &&
    rtPicker.flowsOpts.some(o => o.indexOf("Connections") !== -1),
    JSON.stringify(rtPicker.sysOpts));
  await callTool("click", { selector: "#imp-sheets-next" });
  await waitStep("imp-step-review");
  const mapSkipped = await evalJson("JSON.stringify({ mapHidden: document.getElementById('imp-step-map').hidden })");
  check("D: site's own export skips the mapping step entirely (zero mapping step)",
    mapSkipped.mapHidden === true);
  const rt = await evalJson(REVIEW_STATE);
  check("D: round-trip restores 7 systems", rt.sysRows.length === 7, String(rt.sysRows.length));
  check("D: round-trip restores 5 flows", rt.flowRows.length === 5, String(rt.flowRows.length));
  check("D: categories prefilled contact/payment/marketing/contact/contact",
    JSON.stringify(rt.flowRows.map(f => f.cat)) === JSON.stringify(["contact", "payment", "marketing", "contact", "contact"]),
    JSON.stringify(rt.flowRows.map(f => f.cat)));
  check("D: badges say From your file (trusted file content, not a guess)",
    rt.flowRows.every(f => f.badge === "From your file"), rt.flowRows.map(f => f.badge).join(","));
  check("D: no MISSING_CATEGORY flags on the clean round-trip (categories came from the file)",
    rt.flags.length === 0, JSON.stringify(rt.flags).slice(0, 200));
  check("D: no skipped rows on the clean round-trip", rt.skipped.length === 0, rt.skipped.join(" // ").slice(0, 200));
  check("D: build enabled on the round-trip", rt.buildDisabled === false);
  await callTool("click", { selector: "#imp-build" });
  await waitStep("imp-step-done");
  const rtDone = await evalJson("JSON.stringify(document.getElementById('imp-done-body').textContent)");
  check("D: done summary counts 7 systems, 5 connections, 0 skipped",
    rtDone.indexOf("7 systems placed, 5 connections drawn, 0 rows skipped") !== -1, rtDone.slice(0, 120));
  await callTool("click", { selector: "#imp-build" });
  await waitStep("imp-step-done");
  const rtCs = await evalJson(CANVAS_STATE);
  check("D: restored map has the same 7 node labels",
    JSON.stringify(rtCs.nodes.map(n => n.label).sort()) === JSON.stringify(expNodes));
  check("D: restored map has the same 5 edges",
    JSON.stringify(rtCs.edges.map(e => [e.from, e.to, e.cat])) === JSON.stringify(expEdges),
    JSON.stringify(rtCs.edges.map(e => [e.from, e.to, e.cat])));
  await shot("accept-05-roundtrip", 1280);
  await hygiene("D");

  // ================= E. deliberately broken file =================
  console.log("== E: broken file ==");
  await callTool("click", { selector: "#imp-again" });
  await waitStep("imp-step-file");
  await evalRaw(uploadScript("/accept-tmp/broken.xlsx", "broken.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
  await waitStep("imp-step-sheets");
  await callTool("click", { selector: "#imp-sheets-next" });
  await waitStep("imp-step-map");
  await callTool("click", { selector: "#imp-map-next" });
  await waitStep("imp-step-review");
  const br = await evalJson(REVIEW_STATE);
  const hasFlag = (code, sev, needle) => br.flags.some(f =>
    f.text.indexOf(code) !== -1 || (f.cls.indexOf(sev) !== -1 && f.text.indexOf(needle) !== -1));
  const warnTxt = br.flags.filter(f => f.cls.indexOf("warning") !== -1).map(f => f.text);
  const errTxt = br.flags.filter(f => f.cls.indexOf("error") !== -1).map(f => f.text);
  console.log("warnings:", JSON.stringify(warnTxt).slice(0, 500));
  console.log("errors:", JSON.stringify(errTxt).slice(0, 500));
  check("E: LIKELY_DUPLICATE warning inline for the two Shopify rows",
    warnTxt.some(t => t.indexOf("Shopify") !== -1 && t.toLowerCase().indexOf("same system") !== -1),
    warnTxt.join(" // ").slice(0, 200));
  check("E: INCONSISTENT_NAME warning inline for Klaviyo / Klaviyo Inc",
    warnTxt.some(t => t.indexOf("Klaviyo") !== -1 && t.indexOf("Klaviyo Inc") !== -1),
    warnTxt.join(" // ").slice(0, 200));
  check("E: DANGLING_REF error inline for the Ghost system flow",
    errTxt.some(t => t.indexOf("Ghost system") !== -1), errTxt.join(" // ").slice(0, 200));
  const uncat = br.flowRows.find(f => f.to === "Klaviyo");
  check("E: uncategorizable flow gets MISSING_CATEGORY warning inline",
    warnTxt.some(t => t.indexOf("Shopify") !== -1 && t.indexOf("Klaviyo") !== -1 &&
      t.toLowerCase().indexOf("categor") !== -1),
    warnTxt.join(" // ").slice(0, 260));
  check("E: uncategorizable flow's suggestion is explicit (Suggested + default reason), not silent",
    uncat && uncat.badge === "Suggested" && uncat.note.indexOf("default category") !== -1,
    uncat ? (uncat.badge + " :: " + uncat.note) : "flow not found");
  check("E: unknown-type system rejected and listed under Skipped rows",
    br.skipped.some(s => s.indexOf("Mystery box") !== -1 && s.toLowerCase().indexOf("not a known type") !== -1),
    br.skipped.join(" // ").slice(0, 260));
  // Build-button invariant: clearing a category disables Build; re-picking enables it.
  await evalJson(`JSON.stringify((() => {
    const s = document.getElementById('imp-cat-0');
    s.value = '';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return document.getElementById('imp-build').disabled;
  })())`);
  const disAfterClear = await evalJson("JSON.stringify(document.getElementById('imp-build').disabled)");
  check("E: Build map disabled while any flow lacks a category", disAfterClear === true);
  await evalJson(`JSON.stringify((() => {
    const s = document.getElementById('imp-cat-0');
    s.value = 'contact';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return document.getElementById('imp-build').disabled;
  })())`);
  const disAfterPick = await evalJson("JSON.stringify(document.getElementById('imp-build').disabled)");
  check("E: Build map re-enabled once every flow has a category", disAfterPick === false);
  await shot("accept-06-broken-review");

  await callTool("click", { selector: "#imp-build" });
  await waitStep("imp-step-done");
  const brCs = await evalJson(CANVAS_STATE);
  const brLabels = brCs.nodes.map(n => n.label);
  check("E: duplicates NOT merged: both Shopify rows placed (4 nodes)",
    brCs.nodes.length === 4 && brLabels.filter(l => l === "Shopify").length === 2,
    brLabels.join(" | "));
  check("E: dangling flow's edge NOT drawn (1 edge only, Shopify->Klaviyo contact)",
    brCs.edges.length === 1 && brCs.edges[0].from === "Shopify" &&
    brCs.edges[0].to === "Klaviyo" && brCs.edges[0].cat === "contact",
    JSON.stringify(brCs.edges));
  const doneE = await evalJson("JSON.stringify(document.getElementById('imp-done-body').textContent)");
  check("E: done summary counts 4 systems, 1 connection, 2 rows skipped",
    doneE.indexOf("4 systems placed, 1 connections drawn, 2 rows skipped") !== -1, doneE.slice(0, 120));
  await hygiene("E");

  // ================= F. CSV path (EN) + FR page =================
  console.log("== F: CSV + FR ==");
  await callTool("click", { selector: "#imp-again" });
  await waitStep("imp-step-file");
  await evalRaw(uploadScript("/fixtures/fixture-systems.csv", "fixture-systems.csv", "text/csv"));
  await waitStep("imp-step-map");
  const csvPicker = await evalJson("JSON.stringify({ sheetsHidden: document.getElementById('imp-step-sheets').hidden })");
  check("F: CSV (single sheet) skips the sheet picker", csvPicker.sheetsHidden === true);
  await callTool("click", { selector: "#imp-map-next" });
  await waitStep("imp-step-review");
  await callTool("click", { selector: "#imp-build" });
  await waitStep("imp-step-done");
  const csvCs = await evalJson(CANVAS_STATE);
  check("F: CSV builds 2 nodes, 0 edges first-class",
    csvCs.nodes.length === 2 && csvCs.edges.length === 0, JSON.stringify(csvCs.nodes.map(n => n.label)));
  await hygiene("F-EN");

  console.log(await callTool("navigate", { url: BASE + "/fr.html" }));
  await acceptGate();
  const frHead = await evalJson(
    "JSON.stringify({ title: document.querySelector('#imp-sec .sim-head').textContent })"
  );
  check("F: FR page renders French import heading", frHead.title === "Importer un chiffrier", frHead.title);
  await evalRaw(uploadScript("/fixtures/fixture-systems.csv", "fixture-systems.csv", "text/csv"));
  await waitStep("imp-step-map");
  await callTool("click", { selector: "#imp-map-next" });
  await waitStep("imp-step-review");
  await callTool("click", { selector: "#imp-build" });
  await waitStep("imp-step-done");
  const frDone = await evalJson("JSON.stringify(document.getElementById('imp-done-body').textContent)");
  check("F: FR flow completes with French summary", frDone.indexOf("systèmes placés") !== -1, frDone.slice(0, 120));
  const frCs = await evalJson(CANVAS_STATE);
  check("F: FR canvas shows the 2 CSV nodes", frCs.nodes.length === 2, String(frCs.nodes.length));
  await shot("accept-07-fr", 390);

  // FR round-trip: the page's own .xls (Nœuds/Liens, French display names) back in.
  await evalRaw(`(() => {
    window.__xlsBlobs = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) { try { window.__xlsBlobs.push(blob); } catch (e) {} return orig(blob); };
    return 'wrapped';
  })()`);
  await callTool("click", { selector: "#bn-xls" });
  const frCap = await evalJson(`(async () => {
    const b = (window.__xlsBlobs || [])[0];
    if (!b) return JSON.stringify({ error: 'no blob' });
    const text = await b.text();
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const sheets = [...doc.getElementsByTagName('Worksheet')].map(ws => ({
      name: ws.getAttribute('ss:Name'),
      rows: [...ws.getElementsByTagName('Row')].map(r => [...r.getElementsByTagName('Data')].map(d => d.textContent))
    }));
    return JSON.stringify({ sheets, text });
  })()`);
  check("F: FR export has Nœuds + Liens sheets",
    !frCap.error && frCap.sheets[0].name === "Nœuds" && frCap.sheets[1].name === "Liens",
    frCap.error || frCap.sheets.map(s => s.name).join("/"));
  check("F: FR Nodes sheet uses French headers and type display names",
    JSON.stringify(frCap.sheets[0].rows[2]) === JSON.stringify(["Étiquette", "Type"]) &&
    frCap.sheets[0].rows[3][1] === "Point de collecte" && frCap.sheets[0].rows[4][1] === "Système",
    JSON.stringify(frCap.sheets[0].rows[2]) + " :: " + frCap.sheets[0].rows[3][1]);
  await callTool("click", { selector: "#imp-again" });
  await waitStep("imp-step-file");
  const frUploadScript = "(async () => { const xml = " + JSON.stringify(frCap.text) +
    "; const file = new File([xml], 'carte.xls', { type: 'application/vnd.ms-excel' });" +
    " const dt = new DataTransfer(); dt.items.add(file);" +
    " const input = document.getElementById('imp-file'); input.files = dt.files;" +
    " input.dispatchEvent(new Event('change', { bubbles: true })); return 'dispatched'; })()";
  await evalRaw(frUploadScript);
  await waitStep("imp-step-sheets");
  await callTool("click", { selector: "#imp-sheets-next" });
  await waitStep("imp-step-review");
  const frRt = await evalJson(`JSON.stringify({
    mapHidden: document.getElementById('imp-step-map').hidden,
    sys: document.querySelectorAll('#imp-review-body table.imp-table')[0].rows.length - 1,
    skipped: [...document.querySelectorAll('#imp-review-body .imp-skipped li')].length
  })`);
  check("F: FR round-trip skips the mapping step", frRt.mapHidden === true);
  check("F: FR round-trip restores 2 systems with 0 skipped", frRt.sys === 2 && frRt.skipped === 0,
    "sys=" + frRt.sys + " skipped=" + frRt.skipped);
  await callTool("click", { selector: "#imp-build" });
  await waitStep("imp-step-done");
  const frRtDone = await evalJson("JSON.stringify(document.getElementById('imp-done-body').textContent)");
  check("F: FR round-trip done: 2 systèmes placés, 0 lignes ignorées",
    frRtDone.indexOf("2 systèmes placés") !== -1 && frRtDone.indexOf("0 lignes ignorées") !== -1,
    frRtDone.slice(0, 80));
  await hygiene("F-FR");

  // ================= G. zero third-party scripts =================
  console.log("== G: script audit ==");
  for (const page of ["/index.html", "/fr.html"]) {
    await callTool("navigate", { url: BASE + page });
    const srcs = await evalJson(SCRIPTS_OFF_ORIGIN);
    const offOrigin = srcs.filter(s => /^https?:\/\//i.test(s) || s.indexOf("//") === 0);
    check("G: " + page + " has zero off-origin script tags (" + srcs.length + " local)",
      offOrigin.length === 0, offOrigin.join(","));
  }
  await hygiene("G");

  await callTool("close", {});
  const failed = results.filter((r) => !r.ok);
  console.log("\n== " + (results.length - failed.length) + "/" + results.length + " acceptance checks passed ==");
  child.kill();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("ACCEPT FAILED:", e.message);
  child.kill();
  process.exit(2);
});
