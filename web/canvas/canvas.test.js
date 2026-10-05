/* canvas.test.js - pure-logic tests for canvas.js. Run with: node canvas.test.js */
"use strict";
var assert = require("assert");
var DMCanvas = require("./canvas.js");
var P = DMCanvas.pure;

var passed = 0;
function ok(cond, name) {
  assert.ok(cond, "FAIL: " + name);
  passed++;
}
function approx(a, b, eps, name) {
  assert.ok(Math.abs(a - b) <= (eps == null ? 1e-9 : eps), "FAIL: " + name + " (" + a + " vs " + b + ")");
  passed++;
}

/* ---- zoom clamp edges ---- */
ok(P.clampZoom(0.2) === 0.35, "clamp below min -> 0.35");
ok(P.clampZoom(5) === 3, "clamp above max -> 3");
ok(P.clampZoom(1) === 1, "clamp keeps 1");
ok(P.clampZoom(0.35) === 0.35, "clamp keeps min edge");
ok(P.clampZoom(3) === 3, "clamp keeps max edge");
ok(P.clampZoom(NaN) === 0.35, "clamp NaN -> min");
ok(P.clampZoom(-2) === 0.35, "clamp negative -> min");
ok(P.clampZoom(0) === 0.35, "clamp zero -> min");

/* ---- world/screen round-trip ---- */
(function () {
  var v = { k: 1.5, tx: 100, ty: -40 };
  var s = P.worldToScreen(200, 150, v);
  approx(s.x, 400, 1e-9, "worldToScreen x");
  approx(s.y, 185, 1e-9, "worldToScreen y");
  var w = P.screenToWorld(s.x, s.y, v);
  approx(w.x, 200, 1e-9, "round-trip x");
  approx(w.y, 150, 1e-9, "round-trip y");
})();

/* ---- wheel-zoom-to-cursor keeps cursor anchored ---- */
(function () {
  var v = { k: 1, tx: 0, ty: 0 };
  var under = P.screenToWorld(320, 210, v);
  var nv = P.zoomAround(v, 320, 210, 1.25);
  ok(nv.k === 1.25, "zoomAround applies factor");
  var back = P.worldToScreen(under.x, under.y, nv);
  approx(back.x, 320, 1e-9, "cursor x anchored");
  approx(back.y, 210, 1e-9, "cursor y anchored");
  var clamped = P.zoomAround({ k: 3, tx: 10, ty: 10 }, 100, 100, 2);
  ok(clamped.k === 3, "zoomAround respects max clamp");
  var anchored = P.worldToScreen(P.screenToWorld(100, 100, { k: 3, tx: 10, ty: 10 }).x,
    P.screenToWorld(100, 100, { k: 3, tx: 10, ty: 10 }).y, clamped);
  approx(anchored.x, 100, 1e-9, "anchor holds at clamp edge");
})();

/* ---- fit a 45-node bounds (state-builder space, padded) ---- */
var BIG = { minX: 40 - 60, minY: 40 - 60, maxX: 600 + 60, maxY: 380 + 60 }; /* 680 x 460 */
(function () {
  var t = P.fitTransform(BIG, { w: 1280, h: 800 });
  approx(t.k, Math.min((1280 - 96) / 680, (800 - 96) / 460), 1e-9, "fit k at 1280x800");
  ok(t.k >= P.ZOOM_MIN && t.k <= P.ZOOM_MAX, "fit k in zoom range at 1280x800");
  var a = P.worldToScreen(BIG.minX, BIG.minY, t);
  var b = P.worldToScreen(BIG.maxX, BIG.maxY, t);
  ok(a.x >= 48 - 1e-9 && a.y >= 48 - 1e-9, "fit keeps left/top margin at 1280x800");
  ok(b.x <= 1280 - 48 + 1e-9 && b.y <= 800 - 48 + 1e-9, "fit keeps right/bottom margin at 1280x800");
})();
(function () {
  var t = P.fitTransform(BIG, { w: 360, h: 640 });
  approx(t.k, Math.min((360 - 96) / 680, (640 - 96) / 460), 1e-9, "fit k at 360x640");
  ok(t.k >= P.ZOOM_MIN, "small-view fit k not below min");
  var a = P.worldToScreen(BIG.minX, BIG.minY, t);
  var b = P.worldToScreen(BIG.maxX, BIG.maxY, t);
  ok(b.x - a.x <= 360 - 96 + 1e-9, "fit width respects margins at 360x640");
})();
(function () {
  var t = P.fitTransform({ minX: 100, minY: 100, maxX: 300, maxY: 200 }, { w: 1000, h: 800 });
  approx(t.tx, 1000 / 2 - t.k * 200, 1e-9, "fit centers x");
  approx(t.ty, 800 / 2 - t.k * 150, 1e-9, "fit centers y");
  var tiny = P.fitTransform({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { w: 2000, h: 2000 });
  ok(tiny.k === 3, "fit clamps tiny bounds to max zoom");
})();

/* ---- contentBounds ---- */
(function () {
  var b = P.contentBounds({ n1: { x: 40, y: 40 }, n2: { x: 600, y: 380 } });
  assert.deepStrictEqual(b, { minX: -20, minY: -20, maxX: 660, maxY: 440 });
  passed++;
  ok(P.contentBounds({}) === null, "empty nodes -> null bounds");
  ok(P.contentBounds(null) === null, "null nodes -> null bounds");
})();

/* ---- panToKeepVisible ---- */
(function () {
  var v = { k: 1, tx: 0, ty: 0 };
  var size = { w: 800, h: 600 };
  var nv = P.panToKeepVisible(v, { x0: -100, y0: 100, x1: -40, y1: 160 }, size, 80);
  ok(nv.tx === 180, "pan left-edge node into 80px margin");
  ok(nv.ty === 0, "no vertical move when already visible");
  ok(nv.k === 1, "pan keeps k unchanged");
  var same = P.panToKeepVisible(v, { x0: 200, y0: 200, x1: 300, y1: 300 }, size, 80);
  ok(same.tx === 0 && same.ty === 0, "visible node -> no pan");
  var right = P.panToKeepVisible(v, { x0: 780, y0: 200, x1: 840, y1: 260 }, size, 80);
  ok(right.tx === -120, "pan right-edge node into margin");
  var top = P.panToKeepVisible(v, { x0: 200, y0: -50, x1: 260, y1: 10 }, size, 80);
  ok(top.ty === 130, "pan top-edge node into margin");
  var zoomed = P.panToKeepVisible({ k: 2, tx: 0, ty: 0 }, { x0: -10, y0: 100, x1: 10, y1: 140 }, size, 80);
  ok(zoomed.tx === 100, "pan math scales with k");
})();

/* ---- nodeWorldRect ---- */
(function () {
  ["collection", "system", "thirdparty", "destruction"].forEach(function (type) {
    var r = P.nodeWorldRect({ type: type, x: 100, y: 100 });
    ok(r.x1 > r.x0 && r.y1 > r.y0, type + " rect has area");
    ok(r.x0 <= 100 && r.x1 >= 100 && r.y0 <= 100, type + " rect contains node center");
  });
  var sys = P.nodeWorldRect({ type: "system", x: 0, y: 0 });
  ok(sys.x1 - sys.x0 === 104, "system rect matches 104px shape width");
})();

/* ---- spreadColumns: crowded pipeline columns ---- */
(function () {
  function mkNodes(list) {
    var n = {};
    list.forEach(function (p, i) { n["n" + i] = { type: "system", x: p[0], y: p[1], label: "L" + i }; });
    return n;
  }
  // uncrowded column is a no-op
  var roomy = mkNodes([[310, 80], [310, 200], [310, 320]]);
  var laid = P.spreadColumns(roomy);
  ok(laid.n0.y === 80 && laid.n1.y === 200 && laid.n2.y === 320, "roomy column untouched");
  // crowded column: 5 nodes at 17px spacing get 96px gaps, order kept
  var crowded = mkNodes([[310, 80], [310, 97], [310, 114], [310, 131], [310, 148]]);
  var s1 = P.spreadColumns(crowded);
  var ys = ["n0", "n1", "n2", "n3", "n4"].map(function (id) { return s1[id].y; });
  for (var i = 1; i < ys.length; i++) ok(ys[i] - ys[i - 1] === 96, "crowded column gap " + i + " is 96");
  ok(ys[0] < 80, "crowded column expands upward past original top");
  ok(ys[4] > 148, "crowded column expands downward past original bottom");
  var origCenter = (80 + 148) / 2, newCenter = (ys[0] + ys[4]) / 2;
  approx(newCenter, origCenter, 1, "crowded column recentered on original center");
  // x never changes
  ok(["n0", "n1", "n2", "n3", "n4"].every(function (id) { return s1[id].x === 310; }), "spread keeps x");
  // different x untouched, single node untouched, empty untouched
  var mixed = mkNodes([[80, 80], [310, 90], [545, 300]]);
  var s2 = P.spreadColumns(mixed);
  ok(s2.n0.y === 80 && s2.n1.y === 90 && s2.n2.y === 300, "separate columns untouched");
  ok(JSON.stringify(P.spreadColumns({})), "empty nodes -> empty");
  // input not mutated
  ok(crowded.n2.y === 114, "spread does not mutate input");
  // deterministic
  ok(JSON.stringify(P.spreadColumns(crowded)) === JSON.stringify(P.spreadColumns(crowded)), "spread deterministic");
  // wrapping: 12 crowded nodes with maxChunk 5 -> 3 sub-columns of 4..5
  var tall = mkNodes([[310, 80], [310, 97], [310, 114], [310, 131], [310, 148], [310, 165],
                      [310, 182], [310, 199], [310, 216], [310, 233], [310, 250], [310, 267]]);
  var s3 = P.spreadColumns(tall, 5);
  var xs = {};
  ["n0","n1","n2","n3","n4","n5","n6","n7","n8","n9","n10","n11"].forEach(function (id) {
    var x = s3[id].x;
    xs[x] = (xs[x] || 0) + 1;
  });
  ok(Object.keys(xs).length === 3, "tall column wraps into 3 sub-columns");
  ok(xs[310 - P.SUBCOL_DX] === 5 && xs[310] === 5 && xs[310 + P.SUBCOL_DX] === 2,
    "sub-columns hold 5, 5, 2 nodes left to right");
  var col0 = ["n0","n1","n2","n3","n4"].map(function (id) { return s3[id].y; });
  for (var k = 1; k < col0.length; k++) ok(col0[k] - col0[k - 1] === 96, "wrapped sub-column keeps 96px gaps");
  ok(s3.n5.y === s3.n0.y && s3.n10.y === s3.n0.y, "sub-columns share the same vertical span");
  var wc = (col0[0] + col0[col0.length - 1]) / 2;
  approx(wc, (80 + 267) / 2, 1, "wrapped column recentered on original center");
  // maxChunk larger than the group is a no-op wrap (single column, old behavior)
  var s4 = P.spreadColumns(crowded, 99);
  ok(JSON.stringify(s4) === JSON.stringify(P.spreadColumns(crowded)), "oversize maxChunk matches no-arg behavior");
})();

console.log("canvas.test.js: " + passed + " assertions passed");
