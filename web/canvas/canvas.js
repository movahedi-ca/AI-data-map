/* DMCanvas: pan/zoom viewport for the data-mapping tool.
   Classic script ("use strict", no modules, no dependencies, no network).
   Node visuals mirror the guide builder (builder.js): shapeFor() shapes per
   type (collection circle r24, system rect 104x48 rx8, thirdparty diamond,
   destruction dashed circle + X), invisible tap halos, .node/.shape/.node-label
   classes, edge paths with the same 28/32 trim math, edge classes "edge <cat>".
   Redraws only on applyState/selection change; pan and zoom only move the
   #dm-viewport transform, never rebuild the DOM. */
(function () {
  "use strict";

  var root = (typeof window !== "undefined") ? window : {};
  var NS = "http://www.w3.org/2000/svg";

  var ZOOM_MIN = 0.35, ZOOM_MAX = 3;
  var ZOOM_STEP = 1.25;      /* toolbar / keyboard step */
  var PAN_KEY = 40, PAN_KEY_SHIFT = 160;
  var DRAG_TOL = 4;          /* px: click vs drag threshold */
  var NODE_PAD = 60;         /* fit-to-view padding around node centers */
  var FIT_MARGIN = 48;       /* fit-to-view margin inside the view */
  var FOCUS_MARGIN = 80;     /* keep-visible margin when a node is focused */
  var WORLD_W = 640, WORLD_H = 420; /* builder coordinate space (state-builder clamps x 40-600, y 40-380) */

  var STRINGS = {
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    fitView: "Fit map to view",
    fullscreen: "Fullscreen",
    exitFullscreen: "Exit fullscreen",
    selected: "Selected",
    deselected: "Deselected",
    mapFitted: "Map fitted to view",
    canvasLabel: "Data map canvas"
  };

  /* ---------------- pure math (no DOM; unit-tested) ---------------- */

  function clampZoom(k) {
    if (!(k > 0)) return ZOOM_MIN; /* guards NaN, 0, negatives, undefined */
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));
  }

  function worldToScreen(x, y, view) {
    return { x: x * view.k + view.tx, y: y * view.k + view.ty };
  }

  function screenToWorld(x, y, view) {
    return { x: (x - view.tx) / view.k, y: (y - view.ty) / view.k };
  }

  /* Bounds of node centers expanded by pad; null when empty. */
  function contentBounds(nodes, pad) {
    var p = (pad == null) ? NODE_PAD : pad;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
    for (var id in nodes) {
      if (!Object.prototype.hasOwnProperty.call(nodes, id)) continue;
      var d = nodes[id];
      if (!d || !(d.x > -Infinity) || !(d.y > -Infinity)) continue;
      n++;
      if (d.x < minX) minX = d.x;
      if (d.y < minY) minY = d.y;
      if (d.x > maxX) maxX = d.x;
      if (d.y > maxY) maxY = d.y;
    }
    if (!n) return null;
    return { minX: minX - p, minY: minY - p, maxX: maxX + p, maxY: maxY + p };
  }

  /* View transform that fits bounds into viewSize with FIT_MARGIN on each
     side and k clamped to the zoom range. */
  function fitTransform(bounds, viewSize) {
    var b = bounds || { minX: 0, minY: 0, maxX: WORLD_W, maxY: WORLD_H };
    var w = Math.max(1, viewSize.w), h = Math.max(1, viewSize.h);
    var bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
    var k = clampZoom(Math.min((w - 2 * FIT_MARGIN) / bw, (h - 2 * FIT_MARGIN) / bh));
    var cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    return { k: k, tx: w / 2 - k * cx, ty: h / 2 - k * cy };
  }

  /* Zoom centered on the screen point (cx, cy); that point stays anchored
     on the same world point after clamping. */
  function zoomAround(view, cx, cy, factor) {
    var wpt = screenToWorld(cx, cy, view);
    var k = clampZoom(view.k * factor);
    return { k: k, tx: cx - wpt.x * k, ty: cy - wpt.y * k };
  }

  /* Minimal translation (k unchanged) so the world rect sits fully inside
     the view with the given margin; no move when already visible. */
  function panToKeepVisible(view, rect, viewSize, margin) {
    var m = (margin == null) ? FOCUS_MARGIN : margin;
    var w = Math.max(1, viewSize.w), h = Math.max(1, viewSize.h);
    var a = worldToScreen(rect.x0, rect.y0, view);
    var b = worldToScreen(rect.x1, rect.y1, view);
    var sx = 0, sy = 0;
    if (a.x < m) sx = m - a.x;
    else if (b.x > w - m) sx = (w - m) - b.x;
    if (a.y < m) sy = m - a.y;
    else if (b.y > h - m) sy = (h - m) - b.y;
    return { k: view.k, tx: view.tx + sx, ty: view.ty + sy };
  }

  /* Visual footprint of a node in world coords (shape plus label below). */
  function nodeWorldRect(def) {
    var hw, hh0, hh1;
    if (def.type === "system") { hw = 52; hh0 = 24; hh1 = 48; }
    else if (def.type === "thirdparty") { hw = 31; hh0 = 27; hh1 = 48; }
    else { hw = 24; hh0 = 24; hh1 = 48; } /* collection, destruction */
    return { x0: def.x - hw, y0: def.y - hh0, x1: def.x + hw, y1: def.y + hh1 };
  }

  /* De-overlap for crowded columns. The import pipeline stacks same-type
     nodes in fixed-x columns (x 80 / 310 / 545, y spread over 80-320), so a
     45-node map packs ~15 nodes per column at ~17px spacing while a node is
     ~48px tall: without this the map is an unreadable blob. This pass
     spreads crowded columns deterministically: group by exact x, sort by y,
     enforce a minimum vertical gap by pushing down, then recenter the column
     on its original center. Order-preserving; a no-op when spacing is
     already wide enough. Returns fresh position objects; input untouched. */
  var SPREAD_GAP = 96;
  var SUBCOL_DX = 170;   /* horizontal step between wrapped sub-columns */
  function spreadColumns(nodes, maxChunk) {
    var cols = {};
    Object.keys(nodes).forEach(function (id) {
      var x = nodes[id].x;
      (cols[x] || (cols[x] = [])).push(id);
    });
    var pos = {};
    Object.keys(nodes).forEach(function (id) {
      pos[id] = { x: nodes[id].x, y: nodes[id].y };
    });
    Object.keys(cols).forEach(function (x) {
      var group = cols[x].slice().sort(function (a, b) {
        return (nodes[a].y - nodes[b].y) || (a < b ? -1 : 1);
      });
      if (group.length < 2) return;
      var origLo = nodes[group[0]].y;
      var origHi = nodes[group[group.length - 1]].y;
      var ys = group.map(function (id) { return nodes[id].y; });
      var i;
      for (i = 1; i < ys.length; i++) {
        if (ys[i] - ys[i - 1] < SPREAD_GAP) ys[i] = ys[i - 1] + SPREAD_GAP;
      }
      /* A column that would still overflow a fit-to-view at the minimum
         zoom wraps into side-by-side sub-columns, so fitView can always
         frame the whole map. Deterministic; order-preserving; a no-op
         when the column fits in one chunk. */
      var chunk = (maxChunk > 0) ? Math.min(maxChunk, group.length) : group.length;
      var nSub = Math.ceil(group.length / chunk);
      var shift = Math.round(((origLo + origHi) - (ys[0] + ys[chunk - 1])) / 2);
      var x0 = nodes[group[0]].x;
      group.forEach(function (id, j) {
        var s = Math.floor(j / chunk);
        pos[id] = {
          x: nSub > 1 ? x0 + (s - (nSub - 1) / 2) * SUBCOL_DX : x0,
          y: ys[j % chunk] + shift
        };
      });
    });
    return pos;
  }

  var pure = {
    clampZoom: clampZoom,
    worldToScreen: worldToScreen,
    screenToWorld: screenToWorld,
    contentBounds: contentBounds,
    fitTransform: fitTransform,
    zoomAround: zoomAround,
    panToKeepVisible: panToKeepVisible,
    nodeWorldRect: nodeWorldRect,
    spreadColumns: spreadColumns,
    SPREAD_GAP: SPREAD_GAP,
    SUBCOL_DX: SUBCOL_DX,
    ZOOM_MIN: ZOOM_MIN,
    ZOOM_MAX: ZOOM_MAX,
    ZOOM_STEP: ZOOM_STEP,
    NODE_PAD: NODE_PAD,
    FIT_MARGIN: FIT_MARGIN,
    FOCUS_MARGIN: FOCUS_MARGIN
  };

  /* ---------------- init ---------------- */

  function init(opts) {
    opts = opts || {};
    var doc = root.document;
    if (!doc) return null;
    var wrap = doc.getElementById(opts.wrapId || "canvas-wrap");
    var svg = doc.getElementById(opts.svgId || "builder-canvas");
    if (!wrap || !svg) return null;

    var strings = {};
    for (var sk in STRINGS) strings[sk] = STRINGS[sk];
    if (opts.strings) for (var ok in opts.strings) strings[ok] = opts.strings[ok];
    var status = opts.statusId ? doc.getElementById(opts.statusId) : null;

    var nodes = {};   /* id -> {type, x, y, label} */
    var edges = [];   /* {a, b, cat} */
    var selected = null;
    var view = { k: 1, tx: 0, ty: 0 };
    var pseudoFull = false;
    var off = [];     /* [el, type, fn, opts] for destroy() */

    function on(el, type, fn, o) {
      el.addEventListener(type, fn, o);
      off.push([el, type, fn, o]);
    }

    var viewport = svg.querySelector("#dm-viewport");
    if (!viewport) {
      viewport = doc.createElementNS(NS, "g");
      viewport.setAttribute("id", "dm-viewport");
      svg.appendChild(viewport);
    }

    svg.setAttribute("role", "application");
    svg.setAttribute("aria-label", strings.canvasLabel);
    svg.setAttribute("tabindex", "0");
    if (!svg.style.touchAction) svg.style.touchAction = "none"; /* CSS fallback; Worker 2 sets it too */

    function el(name, attrs) {
      var n = doc.createElementNS(NS, name);
      for (var a in attrs) n.setAttribute(a, attrs[a]);
      return n;
    }
    function say(msg) { if (status) status.textContent = msg; }

    function applyView() {
      viewport.setAttribute("transform", "translate(" + view.tx + "," + view.ty + ") scale(" + view.k + ")");
    }

    /* shapeFor: faithful port of the builder renderer. */
    function shapeFor(id, def) {
      var g = el("g", {
        "class": "node" + (selected === id ? " selected" : ""),
        transform: "translate(" + def.x + "," + def.y + ")",
        "data-node": id, tabindex: "0", role: "button",
        "aria-label": def.type + ": " + def.label
      });
      var hit;
      if (def.type === "system") {
        hit = el("rect", { "class": "hit", x: -58, y: -27, width: 116, height: 88, fill: "transparent" });
      } else if (def.type === "thirdparty") {
        hit = el("polygon", { "class": "hit", points: "0,-44 48,0 0,44 -48,0", fill: "transparent" });
      } else {
        hit = el("circle", { "class": "hit", r: 42, fill: "transparent" });
      }
      g.appendChild(hit);
      var s;
      if (def.type === "collection") {
        s = el("circle", { "class": "shape", r: 24, fill: "#ffffff", stroke: "#0f172a", "stroke-width": 2 });
      } else if (def.type === "system") {
        s = el("rect", { "class": "shape", x: -52, y: -24, width: 104, height: 48, rx: 8, fill: "#ffffff", stroke: "#0f172a", "stroke-width": 2 });
      } else if (def.type === "thirdparty") {
        s = el("polygon", { "class": "shape", points: "0,-27 31,0 0,27 -31,0", fill: "#ffffff", stroke: "#0f172a", "stroke-width": 2 });
      } else {
        s = el("g", { "class": "shape" });
        s.appendChild(el("circle", { r: 24, fill: "none", stroke: "#b3401f", "stroke-width": 2, "stroke-dasharray": "5 4" }));
        s.appendChild(el("line", { x1: -13, y1: -13, x2: 13, y2: 13, stroke: "#b3401f", "stroke-width": 3 }));
        s.appendChild(el("line", { x1: -13, y1: 13, x2: 13, y2: -13, stroke: "#b3401f", "stroke-width": 3 }));
      }
      g.appendChild(s);
      var t = el("text", { "class": "node-label", y: 40, "text-anchor": "middle" });
      t.textContent = def.label;
      g.appendChild(t);
      return g;
    }

    function redraw() {
      while (viewport.firstChild) viewport.removeChild(viewport.firstChild);
      edges.forEach(function (e) {
        var A = nodes[e.a], B = nodes[e.b];
        if (!A || !B) return;
        var dx = B.x - A.x, dy = B.y - A.y;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        viewport.appendChild(el("path", {
          "class": "edge " + e.cat,
          d: "M" + (A.x + dx / len * 28) + "," + (A.y + dy / len * 28) +
             " L" + (B.x - dx / len * 32) + "," + (B.y - dy / len * 32)
        }));
      });
      Object.keys(nodes).forEach(function (id) { viewport.appendChild(shapeFor(id, nodes[id])); });
    }

    function refreshSelection() {
      var list = viewport.querySelectorAll("[data-node]");
      for (var i = 0; i < list.length; i++) {
        var on_ = list[i].getAttribute("data-node") === selected;
        if (on_) list[i].classList.add("selected");
        else list[i].classList.remove("selected");
      }
    }

    function toggleSelect(id) {
      if (!nodes[id]) return;
      selected = (selected === id) ? null : id;
      refreshSelection();
      say(selected ? strings.selected + ": " + nodes[id].label : strings.deselected);
    }

    function viewSize() {
      var w = wrap.clientWidth || svg.clientWidth || 0;
      var h = wrap.clientHeight || svg.clientHeight || 0;
      return { w: w, h: h };
    }

    /* ---------------- public API ---------------- */

    function applyState(state) {
      state = state || {};
      var incoming = state.nodes || {};
      /* Presentation layout: spread crowded pipeline columns so a 45-node
         map is explorable. Columns taller than a fit-to-view at the minimum
         zoom wrap into sub-columns. Deterministic and order-preserving;
         copies the node objects so the caller's state is never mutated. */
      var size = viewSize();
      var maxChunk = 10; /* fallback while the wrap has no layout yet */
      if (size.h >= 10) {
        var maxSpan = (size.h - 2 * FIT_MARGIN) / ZOOM_MIN - 2 * NODE_PAD;
        maxChunk = Math.max(1, Math.floor(maxSpan / SPREAD_GAP) + 1);
      }
      var laid = spreadColumns(incoming, maxChunk);
      nodes = {};
      Object.keys(incoming).forEach(function (id) {
        nodes[id] = {
          type: incoming[id].type,
          label: incoming[id].label,
          x: laid[id].x,
          y: laid[id].y
        };
      });
      edges = state.edges || [];
      selected = null;
      redraw();
      fitView();
    }

    function getView() { return { k: view.k, tx: view.tx, ty: view.ty }; }

    function setView(v) {
      v = v || {};
      view = { k: clampZoom(v.k), tx: +v.tx || 0, ty: +v.ty || 0 };
      applyView();
    }

    function fitView() {
      var size = viewSize();
      if (size.w < 10 || size.h < 10) return;
      var bounds = contentBounds(nodes) || { minX: 0, minY: 0, maxX: WORLD_W, maxY: WORLD_H };
      view = fitTransform(bounds, size);
      applyView();
      say(strings.mapFitted);
    }

    function zoomAt(cx, cy, factor) {
      view = zoomAround(view, cx, cy, factor);
      applyView();
    }

    function zoomCentered(factor) {
      var size = viewSize();
      zoomAt(size.w / 2, size.h / 2, factor);
    }

    /* ---------------- fullscreen ---------------- */

    var fullBtn = doc.getElementById("cv-full");

    function fullActive() { return !!doc.fullscreenElement || pseudoFull; }

    function syncFullBtn() {
      if (!fullBtn) return;
      fullBtn.textContent = fullActive() ? strings.exitFullscreen : strings.fullscreen;
      fullBtn.setAttribute("aria-pressed", fullActive() ? "true" : "false");
    }

    function enterPseudo() {
      pseudoFull = true;
      wrap.classList.add("cv-pseudo-full");
      syncFullBtn();
      say(strings.fullscreen);
    }
    function exitPseudo() {
      if (!pseudoFull) return;
      pseudoFull = false;
      wrap.classList.remove("cv-pseudo-full");
      syncFullBtn();
      say(strings.exitFullscreen);
    }
    function toggleFullscreen() {
      if (doc.fullscreenElement) { doc.exitFullscreen(); return; }
      if (pseudoFull) { exitPseudo(); return; }
      if (doc.fullscreenEnabled && wrap.requestFullscreen) {
        var p = wrap.requestFullscreen();
        if (p && p.catch) p.catch(function () { enterPseudo(); });
      } else {
        enterPseudo();
      }
    }
    on(doc, "fullscreenchange", function () {
      pseudoFull = false; /* native mode wins; never both */
      syncFullBtn();
      say(fullActive() ? strings.fullscreen : strings.exitFullscreen);
    });

    /* ---------------- toolbar (all optional) ---------------- */

    function wire(id, fn, label) {
      var b = doc.getElementById(id);
      if (!b) return null;
      if (label) b.setAttribute("aria-label", label);
      on(b, "click", fn);
      return b;
    }
    wire("cv-zoom-in", function () { zoomCentered(ZOOM_STEP); }, strings.zoomIn);
    wire("cv-zoom-out", function () { zoomCentered(1 / ZOOM_STEP); }, strings.zoomOut);
    wire("cv-fit", function () { fitView(); }, strings.fitView);
    if (fullBtn) {
      on(fullBtn, "click", toggleFullscreen);
      fullBtn.setAttribute("aria-label", strings.fullscreen);
      syncFullBtn();
    }

    /* ---------------- wheel zoom ---------------- */

    on(svg, "wheel", function (evt) {
      evt.preventDefault();
      var rect = svg.getBoundingClientRect();
      var dy = evt.deltaMode === 1 ? evt.deltaY * 16 : evt.deltaY;
      zoomAt(evt.clientX - rect.left, evt.clientY - rect.top, Math.exp(-dy * 0.0015));
    }, { passive: false });

    /* ---------------- pan + pinch + tap select ---------------- */

    var pointers = {};   /* pointerId -> {x, y} client coords */
    var downInfo = null; /* single-pointer gesture: {x, y, tx, ty, nodeId, moved} */
    var pinch = null;    /* {d, mx, my, view} screen coords relative to svg */

    function ptrCount() { return Object.keys(pointers).length; }
    function dist(p, q) { return Math.sqrt((p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y)); }
    function nodeIdOf(target) {
      var n = target && target.closest ? target.closest("[data-node]") : null;
      return n ? n.getAttribute("data-node") : null;
    }

    on(svg, "pointerdown", function (evt) {
      pointers[evt.pointerId] = { x: evt.clientX, y: evt.clientY };
      try { svg.setPointerCapture(evt.pointerId); } catch (e) { /* older engines */ }
      var ids = Object.keys(pointers);
      if (ids.length === 2) {
        var rect = svg.getBoundingClientRect();
        var p1 = pointers[ids[0]], p2 = pointers[ids[1]];
        pinch = {
          d: dist(p1, p2),
          mx: (p1.x + p2.x) / 2 - rect.left,
          my: (p1.y + p2.y) / 2 - rect.top,
          view: { k: view.k, tx: view.tx, ty: view.ty }
        };
        downInfo = null;
      } else if (ids.length === 1) {
        downInfo = {
          x: evt.clientX, y: evt.clientY,
          tx: view.tx, ty: view.ty,
          nodeId: nodeIdOf(evt.target),
          moved: false
        };
      }
    });

    on(svg, "pointermove", function (evt) {
      if (!pointers[evt.pointerId]) return;
      pointers[evt.pointerId] = { x: evt.clientX, y: evt.clientY };
      var ids = Object.keys(pointers);
      if (ids.length === 2 && pinch) {
        var rect = svg.getBoundingClientRect();
        var p1 = pointers[ids[0]], p2 = pointers[ids[1]];
        var d = dist(p1, p2);
        var mx = (p1.x + p2.x) / 2 - rect.left;
        var my = (p1.y + p2.y) / 2 - rect.top;
        if (pinch.d > 0) {
          view = zoomAround(pinch.view, pinch.mx, pinch.my, d / pinch.d);
          view.tx += mx - pinch.mx;
          view.ty += my - pinch.my;
          applyView();
        }
        return;
      }
      if (ids.length === 1 && downInfo) {
        var dx = evt.clientX - downInfo.x, dy = evt.clientY - downInfo.y;
        if (!downInfo.moved && Math.sqrt(dx * dx + dy * dy) > DRAG_TOL) downInfo.moved = true;
        if (downInfo.moved && !downInfo.nodeId) {
          view.tx = downInfo.tx + dx;
          view.ty = downInfo.ty + dy;
          applyView();
        }
      }
    });

    function endPointer(evt) {
      delete pointers[evt.pointerId];
      var ids = Object.keys(pointers);
      if (ids.length === 1) {
        /* pinch released to one finger: re-anchor so panning continues cleanly */
        var r = pointers[ids[0]];
        downInfo = { x: r.x, y: r.y, tx: view.tx, ty: view.ty, nodeId: null, moved: true };
        pinch = null;
        return;
      }
      pinch = null;
      if (downInfo && !downInfo.moved && downInfo.nodeId) toggleSelect(downInfo.nodeId);
      downInfo = null;
    }
    on(svg, "pointerup", endPointer);
    on(svg, "pointercancel", endPointer);

    /* ---------------- keyboard ---------------- */

    on(svg, "keydown", function (evt) {
      var nodeEl = evt.target && evt.target.closest ? evt.target.closest("[data-node]") : null;
      if (nodeEl) {
        if (evt.key === "Enter" || evt.key === " ") {
          evt.preventDefault();
          toggleSelect(nodeEl.getAttribute("data-node"));
        }
        return;
      }
      if (evt.target !== svg) return;
      var handled = true;
      switch (evt.key) {
        case "+": case "=": zoomCentered(ZOOM_STEP); break;
        case "-": case "_": zoomCentered(1 / ZOOM_STEP); break;
        case "0": fitView(); break;
        case "f": case "F": toggleFullscreen(); break;
        case "ArrowLeft": view.tx += evt.shiftKey ? PAN_KEY_SHIFT : PAN_KEY; applyView(); break;
        case "ArrowRight": view.tx -= evt.shiftKey ? PAN_KEY_SHIFT : PAN_KEY; applyView(); break;
        case "ArrowUp": view.ty += evt.shiftKey ? PAN_KEY_SHIFT : PAN_KEY; applyView(); break;
        case "ArrowDown": view.ty -= evt.shiftKey ? PAN_KEY_SHIFT : PAN_KEY; applyView(); break;
        case "Escape": exitPseudo(); break;
        default: handled = false;
      }
      if (handled) evt.preventDefault();
    });

    /* Keep a focused node fully in view without changing zoom. */
    on(svg, "focusin", function (evt) {
      var nodeEl = evt.target && evt.target.closest ? evt.target.closest("[data-node]") : null;
      if (!nodeEl) return;
      var def = nodes[nodeEl.getAttribute("data-node")];
      if (!def) return;
      var nv = panToKeepVisible(view, nodeWorldRect(def), viewSize(), FOCUS_MARGIN);
      if (nv.tx !== view.tx || nv.ty !== view.ty) { view = nv; applyView(); }
    });

    /* Escape also exits pseudo fullscreen when focus is elsewhere. */
    on(doc, "keydown", function (evt) {
      if (evt.key === "Escape") exitPseudo();
    });

    function destroy() {
      for (var i = 0; i < off.length; i++) {
        off[i][0].removeEventListener(off[i][1], off[i][2], off[i][3]);
      }
      off.length = 0;
      if (pseudoFull) wrap.classList.remove("cv-pseudo-full");
      if (viewport.parentNode) viewport.parentNode.removeChild(viewport);
      if (root.DMImport && root.DMImport.applyState === applyState) delete root.DMImport.applyState;
    }

    var api = {
      applyState: applyState,
      getView: getView,
      setView: setView,
      fitView: fitView,
      destroy: destroy,
      pure: pure
    };

    /* import.js reads this lazily at Build click. */
    root.DMImport = root.DMImport || {};
    root.DMImport.applyState = applyState;

    applyView();
    return api;
  }

  var DMCanvas = { init: init, pure: pure };
  root.DMCanvas = DMCanvas;
  if (typeof module !== "undefined" && module.exports) module.exports = DMCanvas;
})();
