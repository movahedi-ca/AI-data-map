#!/usr/bin/env node
/* tools/qa-canvas.mjs - Phase 2 canvas acceptance run (Worker 3).
 *
 * Serves nothing itself; expects the staging dir on localhost:
 *   python3 -m http.server 8177 --directory staging
 * Drives the REAL import flow on demo.html: upload fixtures/stress-45.xlsx,
 * pick sheets, confirm the prefilled column mappings, review, build. Then
 * verifies every exit criterion (a) through (m) by execution and prints
 * PASS/FAIL per letter with observed values.
 *
 * Playwright is loaded from the gif-capture workspace install.
 * Run from the canvas working dir: node tools/qa-canvas.mjs
 */
import { createRequire } from "node:module";

const require = createRequire("/home/hatch/workspace/gif-capture/package.json");
const { chromium } = require("playwright");

const BASE = "http://127.0.0.1:8177";
const FIXTURE = BASE + "/canvas/fixtures/stress-45.xlsx";

const results = [];
function check(letter, name, cond, detail) {
  results.push({ letter, name, ok: !!cond, detail: detail || "" });
  console.log((cond ? "PASS" : "FAIL") + " [" + letter + "] " + name +
    (detail ? " :: " + detail : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Read the live view from the #dm-viewport transform attribute. */
const READ_VIEW = `(() => {
  const t = (document.querySelector('#dm-viewport') || {}).getAttribute
    ? document.querySelector('#dm-viewport').getAttribute('transform') || '' : '';
  const m = t.match(/translate\\(([^,]+),([^\\)]+)\\)\\s*scale\\(([^)]+)\\)/);
  return m ? { tx: +m[1], ty: +m[2], k: +m[3] } : null;
})()`;
async function viewOf(page) { return page.evaluate(READ_VIEW); }

function attachHygiene(page) {
  const h = { consoleErrors: [], pageErrors: [], failed: [], external: [] };
  page.on("console", (m) => { if (m.type() === "error") h.consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => h.pageErrors.push(String(e && e.message || e)));
  page.on("requestfailed", (r) => h.failed.push(r.url() + " :: " + (r.failure() || {}).errorText));
  page.on("request", (r) => {
    try {
      const u = new URL(r.url());
      if (u.protocol.startsWith("http") && !["127.0.0.1", "localhost"].includes(u.hostname)) {
        h.external.push(r.url());
      }
    } catch { /* ignore non-URL requests */ }
  });
  return h;
}
function checkHygiene(letter, pageName, h) {
  const errs = h.consoleErrors.concat(h.pageErrors.map((e) => "pageerror: " + e));
  check(letter, pageName + ": zero console errors",
    errs.length === 0, errs.slice(0, 3).join(" | ").slice(0, 300));
  check(letter, pageName + ": zero failed requests",
    h.failed.length === 0, h.failed.slice(0, 3).join(" | ").slice(0, 300));
  check(letter, pageName + ": zero non-localhost requests",
    h.external.length === 0, h.external.slice(0, 3).join(" | ").slice(0, 300));
}

/* Push a served file through the real #imp-file input. */
async function upload(page, url, name) {
  await page.evaluate(async ({ url, name }) => {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const file = new File([buf], name, {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById("imp-file");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { url, name });
}

const vis = (id) => "#" + id + ":not([hidden])";

/* Full wizard: upload -> sheets -> mapping -> review -> build -> done. */
async function runWizard(page) {
  await upload(page, FIXTURE, "stress-45.xlsx");
  await page.waitForSelector(vis("imp-step-sheets") + "," + vis("imp-step-review"), { timeout: 45000 });
  if (await page.locator(vis("imp-step-sheets")).count()) {
    const sysV = await page.locator("#imp-sys-sheet").inputValue();
    const flV = await page.locator("#imp-flows-sheet").inputValue();
    check("a", "sheets step: prefilled picks", sysV !== "" && flV !== "",
      "systems=" + sysV + " flows=" + flV);
    await page.click("#imp-sheets-next");
  }
  await page.waitForSelector(vis("imp-step-map") + "," + vis("imp-step-review"), { timeout: 45000 });
  let mapVals = [];
  if (await page.locator(vis("imp-step-map")).count()) {
    mapVals = await page.$$eval("#imp-map-body select", (els) => els.map((e) => e.value));
    const empty = mapVals.filter((v) => v === "").length;
    check("a", "mapping step: all " + mapVals.length + " column guesses prefilled", empty === 0,
      empty + " empty of " + mapVals.length);
    await page.click("#imp-map-next");
  }
  await page.waitForSelector(vis("imp-step-review"), { timeout: 45000 });
  const catCount = await page.locator('select[id^="imp-cat-"]').count();
  let catFixed = 0;
  for (let i = 0; i < catCount; i++) {
    const sel = page.locator("#imp-cat-" + i);
    if (!(await sel.inputValue())) { await sel.selectOption("contact"); catFixed++; }
  }
  check("a", "review step: " + catCount + " flow categories prefilled", catFixed === 0,
    catFixed + " needed a manual pick");
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.click("#imp-build");
  await page.waitForSelector(vis("imp-step-done"), { timeout: 45000 });
  await page.waitForFunction(
    () => document.querySelectorAll("#dm-viewport [data-node]").length > 0,
    null, { timeout: 30000 });
  const scrollAfter = await page.evaluate(() => window.scrollY);
  return { scrollBefore, scrollAfter };
}

async function main() {
  const browser = await chromium.launch({
    executablePath: "/home/hatch/.cache/ms-playwright/chromium/chrome-linux/chrome",
    args: ["--no-sandbox"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const H = attachHygiene(page);

  /* ============ EN page, full wizard ============ */
  await page.goto(BASE + "/canvas/demo.html", { waitUntil: "load" });
  await page.waitForFunction(() => window.DMCanvas && window.DMImport, null, { timeout: 15000 });
  const { scrollBefore, scrollAfter } = await runWizard(page);

  /* ---- (a) applyState contract ---- */
  const nodeCount = await page.locator("#dm-viewport [data-node]").count();
  const edgeCount = await page.locator("#dm-viewport path.edge").count();
  check("a", "45 nodes rendered", nodeCount === 45, nodeCount + " nodes");
  check("a", "60 edges rendered (60 unique pairs, zero rejected)", edgeCount === 60, edgeCount + " edges");
  const wrapVis = await page.evaluate(() => {
    const r = document.getElementById("canvas-wrap").getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  });
  check("a", "scrollIntoView on build brings the wrap into view", wrapVis,
    "scrollY " + scrollBefore + " -> " + scrollAfter);

  /* ---- (b) fullscreen ---- */
  const wrapSel = "#canvas-wrap";
  await page.click("#cv-full");
  await sleep(600);
  let fsEl = await page.evaluate(() => !!document.fullscreenElement);
  if (fsEl) {
    const isWrap = await page.evaluate(
      () => document.fullscreenElement === document.getElementById("canvas-wrap"));
    check("b", "native fullscreen: document.fullscreenElement is the wrap", isWrap, "");
    await page.evaluate(() => document.getElementById("builder-canvas").focus());
    await page.keyboard.press("f"); /* toggle -> exitFullscreen */
    await sleep(400);
    const exited = await page.evaluate(() => !document.fullscreenElement);
    check("b", "'f' key exits native fullscreen", exited, "");
  } else {
    check("b", "native fullscreen engaged in headless", false, "denied; testing pseudo fallback");
  }
  /* Pseudo fallback path with fullscreenEnabled stubbed off. */
  await page.evaluate(() => {
    Object.defineProperty(document, "fullscreenEnabled", { value: false, configurable: true });
  });
  await page.click("#cv-full");
  await sleep(300);
  const pseudoOn = await page.evaluate(
    () => document.getElementById("canvas-wrap").classList.contains("cv-pseudo-full"));
  check("b", "pseudo-fullscreen fallback engages when fullscreenEnabled=false", pseudoOn, "");
  const ariaPressed = await page.locator("#cv-full").getAttribute("aria-pressed");
  check("b", "fullscreen button aria-pressed syncs", ariaPressed === "true", "aria-pressed=" + ariaPressed);
  await page.keyboard.press("Escape");
  await sleep(300);
  const pseudoOff = await page.evaluate(
    () => !document.getElementById("canvas-wrap").classList.contains("cv-pseudo-full"));
  check("b", "Escape exits pseudo-fullscreen", pseudoOff, "");
  await page.evaluate(() => { delete document.fullscreenEnabled; });

  /* ---- (c) zoom buttons + clamp ---- */
  await page.evaluate(() => document.getElementById("builder-canvas").focus());
  let v0 = await viewOf(page);
  await page.click("#cv-zoom-in");
  let v1 = await viewOf(page);
  check("c", "zoom-in steps x1.25", Math.abs(v1.k - v0.k * 1.25) < 0.001,
    v0.k.toFixed(3) + " -> " + v1.k.toFixed(3));
  await page.click("#cv-zoom-out");
  let v2 = await viewOf(page);
  check("c", "zoom-out steps /1.25", Math.abs(v2.k - v1.k / 1.25) < 0.001,
    v1.k.toFixed(3) + " -> " + v2.k.toFixed(3));
  for (let i = 0; i < 20; i++) await page.click("#cv-zoom-in");
  const vMax = await viewOf(page);
  check("c", "zoom-in hammered 20x clamps to <= 3", vMax.k <= 3 + 1e-9, "k=" + vMax.k);
  for (let i = 0; i < 40; i++) await page.click("#cv-zoom-out");
  const vMin = await viewOf(page);
  check("c", "zoom-out hammered 40x clamps to >= 0.35", vMin.k >= 0.35 - 1e-9, "k=" + vMin.k);
  await page.click("#cv-fit"); /* restore sane view */

  /* ---- (d) wheel zoom anchors to cursor ----
     Chromium rounds fractional clientX/Y on synthetic events to integers,
     like real mouse events, so the test predicts from the rounded client
     coords against the pure zoomAround contract. */
  const wheel = await page.evaluate(() => {
    const svg = document.getElementById("builder-canvas");
    const pure = window.DMCanvas.pure;
    const rect = svg.getBoundingClientRect();
    const parse = () => {
      const t = document.querySelector("#dm-viewport").getAttribute("transform") || "";
      const m = t.match(/translate\(([^,]+),([^\)]+)\)\s*scale\(([^)]+)\)/);
      return { tx: +m[1], ty: +m[2], k: +m[3] };
    };
    const v0 = parse();
    const cX = Math.round(rect.left + 200), cY = Math.round(rect.top + 150);
    const sx = cX - rect.left, sy = cY - rect.top; /* exact handler anchor */
    const expect = pure.zoomAround(v0, sx, sy, Math.exp(120 * 0.0015));
    svg.dispatchEvent(new WheelEvent("wheel",
      { clientX: cX, clientY: cY, deltaY: -120, bubbles: true, cancelable: true }));
    const v1 = parse();
    return {
      err: Math.max(Math.abs(v1.k - expect.k),
        Math.abs(v1.tx - expect.tx), Math.abs(v1.ty - expect.ty)),
      k1: v1.k,
    };
  });
  check("d", "wheel zoom matches pure.zoomAround exactly at the cursor anchor",
    wheel.err < 1e-9, "max err=" + wheel.err.toExponential(1) + ", k -> " + wheel.k1.toFixed(3));

  /* ---- (e) pinch zoom around midpoint ---- */
  const pv0 = await viewOf(page);
  const mid = await page.evaluate(() => {
    const r = document.getElementById("builder-canvas").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.evaluate(({ x, y }) => {
    const svg = document.getElementById("builder-canvas");
    const mk = (type, id, primary, cx, cy) => new PointerEvent(type, {
      pointerId: id, isPrimary: primary, clientX: cx, clientY: cy, bubbles: true, cancelable: true,
    });
    svg.dispatchEvent(mk("pointerdown", 11, true, x - 60, y));
    svg.dispatchEvent(mk("pointerdown", 12, false, x + 60, y));
    svg.dispatchEvent(mk("pointermove", 11, true, x - 90, y));
    svg.dispatchEvent(mk("pointermove", 12, false, x + 90, y));
    svg.dispatchEvent(mk("pointerup", 11, true, x - 90, y));
    svg.dispatchEvent(mk("pointerup", 12, false, x + 90, y));
  }, mid);
  const pv1 = await viewOf(page);
  const ratio = pv1.k / pv0.k;
  check("e", "synthetic pinch (120px -> 180px) zooms 1.5x around midpoint",
    Math.abs(ratio - 1.5) < 0.1, "k " + pv0.k.toFixed(3) + " -> " + pv1.k.toFixed(3));

  /* ---- (f) drag pan + 4px click threshold ---- */
  const emptyPt = await page.evaluate(() => {
    const svg = document.getElementById("builder-canvas");
    const r = svg.getBoundingClientRect();
    const cands = [
      [r.left + 6, r.top + 6], [r.right - 6, r.top + 6],
      [r.left + 6, r.bottom - 6], [r.right - 6, r.bottom - 6],
      [r.left + r.width / 2, r.top + 6], [r.left + 6, r.top + r.height / 2],
    ];
    for (const [x, y] of cands) {
      if (document.elementFromPoint(x, y) === svg) return { x, y };
    }
    return null;
  });
  check("f", "found empty canvas point for drag", !!emptyPt, JSON.stringify(emptyPt));
  const dv0 = await viewOf(page);
  await page.mouse.move(emptyPt.x, emptyPt.y);
  await page.mouse.down();
  await page.mouse.move(emptyPt.x + 120, emptyPt.y + 60, { steps: 8 });
  await page.mouse.up();
  const dv1 = await viewOf(page);
  check("f", "drag pan changes the translate",
    Math.abs(dv1.tx - dv0.tx - 120) < 2 && Math.abs(dv1.ty - dv0.ty - 60) < 2,
    "tx " + dv0.tx.toFixed(1) + " -> " + dv1.tx.toFixed(1) +
    ", ty " + dv0.ty.toFixed(1) + " -> " + dv1.ty.toFixed(1));
  await page.mouse.move(emptyPt.x, emptyPt.y);
  await page.mouse.down();
  await page.mouse.up(); /* click without move */
  const dv2 = await viewOf(page);
  const noSel = await page.locator("#dm-viewport .selected").count();
  check("f", "click without move: no pan, no new selection",
    Math.abs(dv2.tx - dv1.tx) < 1e-9 && Math.abs(dv2.ty - dv1.ty) < 1e-9 && noSel === 0,
    "translate unchanged, selected=" + noSel);

  /* ---- (g) keyboard on the svg ---- */
  await page.evaluate(() => document.getElementById("builder-canvas").focus());
  const kv0 = await viewOf(page);
  await page.keyboard.press("ArrowRight");
  const kv1 = await viewOf(page);
  check("g", "ArrowRight pans 40px", Math.abs((kv0.tx - kv1.tx) - 40) < 0.01,
    "tx " + kv0.tx.toFixed(1) + " -> " + kv1.tx.toFixed(1));
  await page.keyboard.press("+");
  const kv2 = await viewOf(page);
  check("g", "'+' zooms x1.25", Math.abs(kv2.k - kv1.k * 1.25) < 0.001,
    kv1.k.toFixed(3) + " -> " + kv2.k.toFixed(3));
  await page.keyboard.press("0");
  await sleep(200);
  const fitOk = await page.evaluate(() => {
    const wrap = document.getElementById("canvas-wrap").getBoundingClientRect();
    return [...document.querySelectorAll("#dm-viewport [data-node]")].every((n) => {
      const r = n.getBoundingClientRect();
      return r.left >= wrap.left - 1 && r.right <= wrap.right + 1 &&
        r.top >= wrap.top - 1 && r.bottom <= wrap.bottom + 1;
    });
  });
  check("g", "'0' fits: all 45 nodes inside the visible viewport", fitOk, "");
  await page.keyboard.press("f");
  await sleep(500);
  const fOn = await page.evaluate(() =>
    !!document.fullscreenElement ||
    document.getElementById("canvas-wrap").classList.contains("cv-pseudo-full"));
  await page.keyboard.press("f");
  await sleep(500);
  const fOff = await page.evaluate(() =>
    !document.fullscreenElement &&
    !document.getElementById("canvas-wrap").classList.contains("cv-pseudo-full"));
  check("g", "'f' toggles fullscreen on and off", fOn && fOff, "on=" + fOn + " off=" + fOff);

  /* ---- (h) fit-to-view from a random view ---- */
  await page.evaluate(() => {
    document.querySelector("#dm-viewport")
      .setAttribute("transform", "translate(600,400) scale(2.2)");
  });
  await page.click("#cv-fit");
  await sleep(200);
  const hOk = await page.evaluate(() => {
    const wrap = document.getElementById("canvas-wrap").getBoundingClientRect();
    const bad = [...document.querySelectorAll("#dm-viewport [data-node]")].filter((n) => {
      const r = n.getBoundingClientRect();
      return !(r.left >= wrap.left - 1 && r.right <= wrap.right + 1 &&
        r.top >= wrap.top - 1 && r.bottom <= wrap.bottom + 1);
    });
    return { ok: bad.length === 0, bad: bad.length };
  });
  check("h", "fit after random zoom/pan: every node inside wrap bounds", hOk.ok, hOk.bad + " outside");

  /* ---- (i) keyboard parity: Tab through all nodes ---- */
  await page.evaluate(() => document.getElementById("builder-canvas").focus());
  const tabbed = new Set();
  for (let i = 0; i < 45; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => {
      const a = document.activeElement;
      return a && a.getAttribute ? a.getAttribute("data-node") : null;
    });
    if (id) tabbed.add(id);
  }
  check("i", "Tab reaches all 45 nodes", tabbed.size === 45, tabbed.size + " unique focused");
  const focusedId = await page.evaluate(() =>
    document.activeElement && document.activeElement.getAttribute("data-node"));
  await page.keyboard.press("Enter");
  await sleep(150);
  const selState = await page.evaluate((fid) => ({
    cls: document.querySelector('[data-node="' + fid + '"]').classList.contains("selected"),
    status: document.getElementById("cv-status").textContent,
  }), focusedId);
  check("i", "Enter selects the focused node and announces it",
    selState.cls && /^Selected: /.test(selState.status),
    "selected=" + selState.cls + " status=" + JSON.stringify(selState.status).slice(0, 60));
  const inView = await page.evaluate((fid) => {
    const wrap = document.getElementById("canvas-wrap").getBoundingClientRect();
    const r = document.querySelector('[data-node="' + fid + '"]').getBoundingClientRect();
    return r.left >= wrap.left && r.right <= wrap.right && r.top >= wrap.top && r.bottom <= wrap.bottom;
  }, focusedId);
  check("i", "focused node is panned into view", inView, "");
  await page.keyboard.press("Enter");
  await sleep(150);
  const desel = await page.evaluate((fid) => ({
    cls: document.querySelector('[data-node="' + fid + '"]').classList.contains("selected"),
    status: document.getElementById("cv-status").textContent,
  }), focusedId);
  check("i", "Enter again deselects and announces", !desel.cls && desel.status === "Deselected",
    "selected=" + desel.cls + " status=" + JSON.stringify(desel.status));

  /* ---- (j) label legibility ---- */
  await page.evaluate(() => {
    document.querySelector("#dm-viewport").setAttribute("transform", "translate(0,0) scale(0.35)");
  });
  const labelCss = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector(".node-label"));
    return { size: parseFloat(cs.fontSize), paintOrder: cs.paintOrder };
  });
  check("j", "min zoom: 14px label * 0.35 ~= 5px screen and halo present",
    labelCss.size * 0.35 >= 4.9 - 1e-6 && labelCss.paintOrder === "stroke",
    (labelCss.size * 0.35).toFixed(1) + "px screen (~5px), paint-order=" + labelCss.paintOrder);
  await page.evaluate(() => {
    document.querySelector("#dm-viewport").setAttribute("transform", "translate(0,0) scale(3)");
  });
  const maxLabelW = await page.evaluate(() =>
    Math.max(...[...document.querySelectorAll(".node-label")].map((t) => t.getBoundingClientRect().width)));
  check("j", "max zoom: labels do not overflow absurdly", maxLabelW < 1500,
    "widest label " + Math.round(maxLabelW) + "px screen");
  await page.click("#cv-fit");

  /* ---- (m) hygiene, EN page ---- */
  checkHygiene("m", "EN page", H);
  await ctx.close();

  /* ============ mobile 390x844 ============ */
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
  });
  const mp = await mctx.newPage();
  const MH = attachHygiene(mp);
  await mp.goto(BASE + "/canvas/demo.html", { waitUntil: "load" });
  await mp.waitForFunction(() => window.DMCanvas && window.DMImport, null, { timeout: 15000 });
  const btnSizes = await mp.$$eval("#cv-toolbar button", (els) =>
    els.map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.width) + "x" + Math.round(r.height); }));
  const btnOk = await mp.$$eval("#cv-toolbar button", (els) =>
    els.every((e) => { const r = e.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; }));
  check("k", "all toolbar buttons >= 44px touch targets", btnOk, btnSizes.join(", "));
  await runWizard(mp);
  const mNodes = await mp.locator("#dm-viewport [data-node]").count();
  check("k", "canvas renders all 45 nodes at 390x844", mNodes === 45, mNodes + " nodes");
  const mPt = await mp.evaluate(() => {
    const svg = document.getElementById("builder-canvas");
    const r = svg.getBoundingClientRect();
    const cands = [
      [r.left + 6, r.top + 6], [r.right - 6, r.top + 6],
      [r.left + 6, r.bottom - 6], [r.right - 6, r.bottom - 6],
      [r.left + r.width / 2, r.top + 6], [r.left + 6, r.top + r.height / 2],
    ];
    for (const [x, y] of cands) {
      if (document.elementFromPoint(x, y) === svg) return { x, y };
    }
    return null;
  });
  check("k", "found empty canvas point on mobile", !!mPt, JSON.stringify(mPt));
  const mv0 = await viewOf(mp);
  await mp.mouse.move(mPt.x, mPt.y);
  await mp.mouse.down();
  await mp.mouse.move(mPt.x + 80, mPt.y + 60, { steps: 8 });
  await mp.mouse.up();
  const mv1 = await viewOf(mp);
  check("k", "one drag-pan works on mobile viewport",
    Math.abs(mv1.tx - mv0.tx) > 10 || Math.abs(mv1.ty - mv0.ty) > 10,
    "tx " + mv0.tx.toFixed(1) + " -> " + mv1.tx.toFixed(1));
  checkHygiene("m", "EN page (mobile)", MH);
  await mctx.close();

  /* ============ FR page ============ */
  const fctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const fp = await fctx.newPage();
  const FH = attachHygiene(fp);
  await fp.goto(BASE + "/canvas/demo-fr.html", { waitUntil: "load" });
  await fp.waitForFunction(() => window.DMCanvas && window.DMImport, null, { timeout: 15000 });
  const frLabels = await fp.$$eval("#cv-toolbar button", (els) =>
    els.map((e) => e.id + "=" + e.getAttribute("aria-label")));
  const frOk = /Zoom avant/.test(frLabels.join()) && /Zoom arri\u00e8re/.test(frLabels.join()) &&
    /Ajuster/.test(frLabels.join()) && /Plein \u00e9cran/.test(frLabels.join());
  check("l", "FR toolbar aria-labels in French", frOk, frLabels.join(" | "));
  await runWizard(fp);
  const frNodes = await fp.locator("#dm-viewport [data-node]").count();
  const frEdges = await fp.locator("#dm-viewport path.edge").count();
  check("l", "FR page: import-build renders the map", frNodes === 45 && frEdges === 60,
    frNodes + " nodes, " + frEdges + " edges");
  checkHygiene("m", "FR page", FH);
  await fctx.close();

  await browser.close();

  const fails = results.filter((r) => !r.ok);
  console.log("\n==== SUMMARY: " + (results.length - fails.length) + "/" + results.length +
    " passed, " + fails.length + " failed ====");
  if (fails.length) {
    console.log("failures:");
    fails.forEach((f) => console.log("  [" + f.letter + "] " + f.name + " :: " + f.detail));
  }
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
