/* v4 - workspace canvas (2026-10-05). Client-side only: nothing leaves the browser.
   The locked empty state is static page HTML (#workspace-locked); this script
   only toggles it through window.DMWorkspace. Nodes arrive from the assistant
   through window.DMImport, from double-click quick-add, or from the node menu.
   Interactions: drag with snap guides (pointer events, mouse + touch),
   right-click / long-press context menu, inline rename, inline setup panel
   writing set_meta, change type, arm-to-connect, remove with inline confirm,
   keyboard move / rename / menu / delete, double-click rename / quick-add,
   dot grid, fit-to-screen, selection + focus rings.
   Menu actions route through window.__s1executor.applyCorrection when an
   assistant session is live, otherwise they apply to local canvas state.
   Drag end commits {op:"move", node_id, x, y} (clamped 40-600 / 40-380) so the
   executor state (table, export, wipe) stays consistent; the canvas repaints
   from executor state through the DMImport.applyState path. */
(function () {
  "use strict";
  var T = (window.T && window.T.builder) || {};
  var NS = "http://www.w3.org/2000/svg";

  /* ------------------------------------------------------------------
     window.DMImport: the assistant-to-builder seam (2026-10-05).
     The assistant's per-step paintCanvas() drives the real step-5 canvas
     through this seam; before this seam existed, DMImport was undefined
     and every paint was a guarded no-op.
       applyState({nodes, edges})  replace the canvas content with the
                                   executor state (nodes: id -> {type, x,
                                   y, label}; edges: [{a, b, cat}])
       getView() / setView(view)   capture/restore the view (viewBox and
                                   any pan/zoom the builder uses) so
                                   applyState never refits or jumps zoom
     The builder sits behind the locked empty state: if the workspace has
     not been unlocked yet, applyState queues the state and it is applied
     when unlock() boots the canvas, so no step's output is lost.
     Nodes/edges render through the builder's own shapeFor/redraw
     machinery, so an assistant-painted map looks identical to a
     hand-built one.
     ------------------------------------------------------------------ */
  var canvasApi = null;    /* set by initCanvas when the canvas boots */
  var pendingState = null; /* queued while the workspace is locked */

  var DM_NODE_TYPES = ["collection", "system", "thirdparty", "destruction"];
  var DM_EDGE_CATS = ["contact", "payment", "marketing"];

  function dmNormalize(state) {
    var nodes = {}, edges = [];
    var sn = (state && state.nodes) || {};
    Object.keys(sn).forEach(function (id) {
      var n = sn[id] || {};
      nodes[id] = {
        type: DM_NODE_TYPES.indexOf(n.type) !== -1 ? n.type : "system",
        x: Math.max(40, Math.min(600, Number(n.x) || 320)),
        y: Math.max(40, Math.min(380, Number(n.y) || 210)),
        label: String(n.label !== undefined && n.label !== null ? n.label : id)
      };
    });
    ((state && state.edges) || []).forEach(function (e) {
      if (e && nodes[e.a] && nodes[e.b] && e.a !== e.b) {
        edges.push({
          a: e.a,
          b: e.b,
          cat: DM_EDGE_CATS.indexOf(e.cat) !== -1 ? e.cat : "contact"
        });
      }
    });
    return { nodes: nodes, edges: edges };
  }

  window.DMImport = {
    applyState: function (state) {
      var norm = dmNormalize(state);
      if (canvasApi) {
        canvasApi.applyState(norm);
      } else {
        pendingState = norm;
      }
    },
    getView: function () {
      if (canvasApi) return canvasApi.getView();
      return { viewBox: "0 0 640 420" };
    },
    setView: function (view) {
      if (canvasApi && view) canvasApi.setView(view);
    },
    /* Test hook: is the canvas live yet? */
    _hasCanvas: function () { return !!canvasApi; }
  };

  /* ------------------------------------------------------------------
     English defaults for the workspace chrome. Every user-facing string
     added by the interaction pass resolves through tx(): window.T.builder
     wins when the page dictionary defines the key, otherwise the default
     below is used. The Quebec French mirror lives in
     tests/workspace-i18n-fr.md; the coordinator wires it into the FR
     page's window.T.builder dictionary.
     ------------------------------------------------------------------ */
  var I18N_DEFAULTS = {
    fitScreen: "Fit to screen",
    fitDone: "View reset.",
    menuRename: "Rename",
    menuSetup: "Set up",
    menuType: "Change type",
    menuFlow: "Add flow from here",
    menuRemove: "Remove",
    menuAddHere: "Add node here",
    kindTitle: "Add node",
    kindCancel: "Cancel",
    hintEnter: "Enter",
    hintDel: "Del",
    renameAria: "Rename node",
    renamed: "Renamed",
    removeAsk: "Remove this node and its connections?",
    removeYes: "Yes, remove",
    removeKeep: "Keep",
    removed: "Removed",
    setupTitle: "Node details",
    setupNotes: "Notes",
    setupHolds: "What it holds",
    setupWhy: "Why it is shared",
    setupRegion: "Region",
    setupSave: "Save",
    setupCancel: "Cancel",
    setupSaved: "Details saved.",
    typeSet: "Type changed",
    moved: "Moved",
    flowArmed: "Flow starts here. Tap another node to connect it.",
    menuAria: "Node menu",
    emptyMenuAria: "Canvas menu",
    kindAria: "Choose the node kind",
    typeCollection: "Collection point",
    typeSystem: "System",
    typeThird: "Third party",
    typeDestroy: "Secure destruction",
    catContact: "Contact / identity",
    catPayment: "Payment",
    catMarketing: "Marketing / consent"
  };

  /* ------------------------------------------------------------------
     window.DMWorkspace: the locked-workspace contract.
       unlock()      hide the locked empty state, show the canvas, boot it
                     on first use, fire onUnlock callbacks
       lock()        return to the locked empty state (canvas state kept)
       isUnlocked()  whether the workspace is currently open
       onUnlock(fn)  register a callback fired on every unlock; fires
                     immediately if already unlocked
     There is no gate anymore: the locked empty state is static HTML and
     unlock() never re-prompts. Reloading the page returns to locked;
     executor state is in-memory only, so there is nothing stale to show.
     ------------------------------------------------------------------ */
  var lockedEl = document.getElementById("workspace-locked");
  var app = document.getElementById("builder-app");

  var appStarted = false;  /* initCanvas has run */
  var wsUnlocked = false;
  var unlockCbs = [];

  function fireUnlockCbs() {
    var cbs = unlockCbs.slice();
    for (var i = 0; i < cbs.length; i++) {
      try { cbs[i](); } catch (e) { /* a callback must not break unlock */ }
    }
  }

  window.DMWorkspace = {
    unlock: function () {
      if (lockedEl) lockedEl.hidden = true;
      if (app) app.hidden = false;
      if (!appStarted && app) {
        initCanvas();
        appStarted = true;
      }
      wsUnlocked = true;
      fireUnlockCbs();
      if (app && app.scrollIntoView) {
        try { app.scrollIntoView({ block: "nearest" }); } catch (e) { /* best-effort */ }
      }
    },
    lock: function () {
      wsUnlocked = false;
      if (app) app.hidden = true;
      if (lockedEl) lockedEl.hidden = false;
    },
    isUnlocked: function () { return wsUnlocked; },
    onUnlock: function (fn) {
      if (typeof fn !== "function") return;
      unlockCbs.push(fn);
      if (wsUnlocked) {
        try { fn(); } catch (e) { /* best-effort */ }
      }
    }
  };

  if (!app) return;

  function initCanvas() {
    var svg = document.getElementById("builder-canvas");
    var wrap = document.getElementById("canvas-wrap");
    var delBtn = document.getElementById("bn-delete");
    var wipeBtn = document.getElementById("bn-wipe");
    var saveBtn = document.getElementById("bn-save");
    var loadIn = document.getElementById("bn-load");
    var printBtn = document.getElementById("bn-print");
    var xlsBtn = document.getElementById("bn-xls");
    var status = document.getElementById("builder-status");
    if (!svg || !status) return;

    /* Localized chrome: page dictionary wins, English default otherwise. */
    function tx(k) {
      return (T[k] !== undefined && T[k] !== null) ? T[k] : I18N_DEFAULTS[k];
    }

    /* Localized human-readable names for node types and edge categories:
       aria-labels and the inventory/export tables reuse these instead of
       raw English ids ("thirdparty" is not a word in any language). */
    var typeNames = {
      collection: tx("typeCollection"),
      system: tx("typeSystem"),
      thirdparty: tx("typeThird"),
      destruction: tx("typeDestroy")
    };
    var catNames = {
      contact: tx("catContact"),
      payment: tx("catPayment"),
      marketing: tx("catMarketing")
    };

    var nodes = {};   // id -> {type, x, y, label, meta?}
    var edges = [];   // {a, b, cat}
    var seq = 0;
    var selected = null;
    var dirty = false;
    var recentAdds = []; // {id, t} for double-click quick-add dedup

    svg.setAttribute("viewBox", "0 0 640 420");
    svg.setAttribute("role", "application");
    svg.setAttribute("aria-label", T.canvasLabel || "Draft mapping canvas");

    function el(name, attrs) {
      var n = document.createElementNS(NS, name);
      for (var k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    }
    function esc(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }
    function say(msg) { status.textContent = msg; }
    function markDirty() {
      dirty = true;
    }
    window.addEventListener("beforeunload", function (e) {
      if (dirty && Object.keys(nodes).length) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    function clampN(v, lo, hi) {
      v = Number(v);
      if (!isFinite(v)) v = lo;
      return Math.max(lo, Math.min(hi, v));
    }
    function addClass(elm, c) {
      if (!elm) return;
      var cur = (elm.getAttribute("class") || "").split(/\s+/);
      if (cur.indexOf(c) === -1) cur.push(c);
      elm.setAttribute("class", cur.join(" ").replace(/^\s+/, ""));
    }
    function removeClass(elm, c) {
      if (!elm) return;
      var cur = (elm.getAttribute("class") || "").split(/\s+/).filter(function (x) { return x && x !== c; });
      elm.setAttribute("class", cur.join(" "));
    }
    function detach(elm) {
      if (elm && elm.parentNode) elm.parentNode.removeChild(elm);
    }
    function setPos(elm, x, y) {
      if (elm && elm.style) {
        elm.style.left = Math.round(x) + "px";
        elm.style.top = Math.round(y) + "px";
      }
    }

    /* --------------------------------------------------------------
       Executor seam for menu actions and drag persistence.
       window.__s1executor is the executor hooks object (api.hooks);
       applyCorrection throws when no session is live, in which case the
       op applies to local canvas state instead. After a successful
       executor op the canvas repaints from executor state through
       DMImport.applyState, so table / export / wipe stay consistent.
       -------------------------------------------------------------- */
    var committedOps = []; /* every op attempted, for tests and debugging */
    function executorHooks() {
      var h = window.__s1executor;
      if (!h) return null;
      if (typeof h.applyCorrection === "function") return h;
      if (h.hooks && typeof h.hooks.applyCorrection === "function") return h.hooks;
      return null;
    }
    function resyncFromExecutor() {
      try {
        var hk = executorHooks();
        var st = (hk && typeof hk.state === "function") ? hk.state() : null;
        if (st && st.nodes && window.DMImport) window.DMImport.applyState(st);
      } catch (e) { /* resync is best-effort */ }
    }
    function commitOp(op, localFn) {
      committedOps.push(op);
      var hk = executorHooks();
      if (hk) {
        try {
          hk.applyCorrection(op);
          resyncFromExecutor();
          return true;
        } catch (e) { /* no session or rejected: apply locally */ }
      }
      localFn();
      markDirty();
      redraw();
      return false;
    }

    /* Local mirrors of the executor correction ops, used when no
       assistant session is live. */
    function localMove(id, x, y) {
      var n = nodes[id];
      if (n) { n.x = clampN(x, 40, 600); n.y = clampN(y, 40, 380); }
    }
    function localRelabel(id, label) {
      var n = nodes[id];
      if (n && label) n.label = label;
    }
    function localRetype(id, type) {
      var n = nodes[id];
      if (n && DM_NODE_TYPES.indexOf(type) !== -1) n.type = type;
    }
    function localRemove(id) {
      if (!nodes[id]) return;
      delete nodes[id];
      edges = edges.filter(function (e) { return e.a !== id && e.b !== id; });
      if (selected === id) selected = null;
    }
    function localAdd(pt, type, label) {
      var id = "n" + (++seq);
      nodes[id] = {
        type: DM_NODE_TYPES.indexOf(type) !== -1 ? type : "collection",
        x: Math.round(clampN(pt.x, 40, 600)),
        y: Math.round(clampN(pt.y, 40, 380)),
        label: label
      };
      recentAdds.push({ id: id, t: Date.now() });
      return id;
    }
    var META_KEYS = ["notes", "holds", "why", "region"];
    function localSetMeta(id, meta) {
      var n = nodes[id];
      if (!n) return;
      n.meta = n.meta || {};
      META_KEYS.forEach(function (k) {
        if (meta[k] === undefined) return;
        if (meta[k]) n.meta[k] = String(meta[k]);
        else delete n.meta[k];
      });
    }

    function shapeFor(id, def) {
      var g = el("g", {
        "class": "node" + (selected === id ? " selected" : ""),
        transform: "translate(" + def.x + "," + def.y + ")",
        "data-node": id, tabindex: "0", role: "button",
        "aria-selected": selected === id ? "true" : "false",
        "aria-label": (typeNames[def.type] || def.type) + ": " + def.label
      });
      /* Invisible tap halo: covers the shape plus its label, so taps on the
         label (or near a small node on a phone screen) select the node
         instead of falling through to the canvas and adding a new node. */
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
      /* The canvas header names the state: blank until the first node
         lands (hand-drawn or assistant-painted), draft map after, blank
         again on wipe. */
      var simHead = document.getElementById("builder-simhead");
      if (simHead) simHead.textContent = Object.keys(nodes).length ?
        (T.canvasDraft || "Draft map") : (T.canvasBlank || "Blank canvas");
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      edges.forEach(function (e) {
        var A = nodes[e.a], B = nodes[e.b];
        if (!A || !B) return;
        var dx = B.x - A.x, dy = B.y - A.y;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        var p = el("path", {
          "class": "edge " + e.cat,
          d: "M" + (A.x + dx / len * 28) + "," + (A.y + dy / len * 28) +
             " L" + (B.x - dx / len * 32) + "," + (B.y - dy / len * 32)
        });
        svg.appendChild(p);
      });
      Object.keys(nodes).forEach(function (id) { svg.appendChild(shapeFor(id, nodes[id])); });
    }

    function svgPoint(evt) {
      var r = svg.getBoundingClientRect();
      var cx = (evt.clientX - r.left) / r.width * 640;
      var cy = (evt.clientY - r.top) / r.height * 420;
      var p = evt.touches && evt.touches[0] ? evt.touches[0] : null;
      if (p) { cx = (p.clientX - r.left) / r.width * 640; cy = (p.clientY - r.top) / r.height * 420; }
      return { x: Math.max(40, Math.min(600, cx)), y: Math.max(40, Math.min(380, cy)) };
    }

    function addNode(pt) {
      var label = tx("untitled") || "Untitled node";
      localAdd(pt, "collection", label);
      markDirty();
      redraw();
      say((T.added || "Added") + ": " + label);
    }

    function activateNode(id) {
      if (selected && selected !== id) {
        var cat = "contact";
        if (!edges.some(function (e) { return (e.a === selected && e.b === id) || (e.a === id && e.b === selected); })) {
          edges.push({ a: selected, b: id, cat: cat });
          markDirty();
          say((T.connected || "Connected") + " (" + (catNames[cat] || cat) + ")");
        }
        selected = null;
      } else {
        selected = (selected === id) ? null : id;
        say(selected ? (T.sel || "Selected") + ": " + nodes[id].label + ". " + (T.tapOther || "Tap another node to connect.") : (T.desel || "Deselected"));
      }
      redraw();
    }

    /* --------------------------------------------------------------
       Drag: pointer events cover mouse and touch. The tap behavior
       (select / connect / add) still fires on pointerdown, exactly as
       before; a drag only starts once the pointer travels past the
       start threshold. On drop the move commits through commitOp so the
       executor sees it when a session is live.
       -------------------------------------------------------------- */
    var press = null;
    var LONG_PRESS_MS = 500, MOVE_CANCEL_PX = 10, DRAG_START_PX = 8, SNAP_PX = 6;
    var guideEls = [];
    var docMove = null, docUp = null;

    function addDocMoveUp() {
      removeDocMoveUp();
      if (!document.addEventListener) return;
      docMove = function (evt) { onPressMove(evt); };
      docUp = function (evt) { onPressUp(evt); };
      document.addEventListener("pointermove", docMove);
      document.addEventListener("pointerup", docUp);
      document.addEventListener("pointercancel", docUp);
    }
    function removeDocMoveUp() {
      if (docMove && document.removeEventListener) {
        document.removeEventListener("pointermove", docMove);
        docMove = null;
      }
      if (docUp && document.removeEventListener) {
        document.removeEventListener("pointerup", docUp);
        document.removeEventListener("pointercancel", docUp);
        docUp = null;
      }
    }
    function drawGuides(gx, gy) {
      hideGuides();
      if (gx !== null && gx !== undefined) {
        guideEls.push(el("line", { "class": "snap-guide", x1: gx, y1: 0, x2: gx, y2: 420 }));
      }
      if (gy !== null && gy !== undefined) {
        guideEls.push(el("line", { "class": "snap-guide", x1: 0, y1: gy, x2: 640, y2: gy }));
      }
      guideEls.forEach(function (l) { svg.appendChild(l); });
    }
    function hideGuides() {
      guideEls.forEach(function (l) { detach(l); });
      guideEls = [];
    }

    function onPressMove(evt) {
      if (!press) return;
      var dx = (evt.clientX || 0) - press.cx;
      var dy = (evt.clientY || 0) - press.cy;
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_CANCEL_PX && press.timer) {
        clearTimeout(press.timer);
        press.timer = null;
      }
      var def = nodes[press.id];
      if (!def || press.menuOpened) return;
      var pt = svgPoint(evt);
      if (!press.dragging) {
        var sdx = pt.x - press.sx, sdy = pt.y - press.sy;
        if (Math.sqrt(sdx * sdx + sdy * sdy) < DRAG_START_PX) return;
        press.dragging = true;
        var g0 = svg.querySelector('[data-node="' + press.id + '"]');
        addClass(g0, "dragging");
        addClass(svg, "dragging-node");
        if (evt.preventDefault) evt.preventDefault();
      }
      /* Snap to other nodes' centers within SNAP_PX; guides show the
         alignment. The live position commits on drop. */
      var px = pt.x, py = pt.y, gx = null, gy = null;
      Object.keys(nodes).forEach(function (oid) {
        if (oid === press.id) return;
        var o = nodes[oid];
        if (Math.abs(o.x - px) <= SNAP_PX) { px = o.x; gx = o.x; }
        if (Math.abs(o.y - py) <= SNAP_PX) { py = o.y; gy = o.y; }
      });
      def.x = px;
      def.y = py;
      var g = svg.querySelector('[data-node="' + press.id + '"]');
      if (g) g.setAttribute("transform", "translate(" + px + "," + py + ")");
      drawGuides(gx, gy);
    }

    function onPressUp() {
      var p = press;
      if (!p) return;
      press = null;
      if (p.timer) { clearTimeout(p.timer); p.timer = null; }
      removeDocMoveUp();
      hideGuides();
      var g = svg.querySelector('[data-node="' + p.id + '"]');
      removeClass(g, "dragging");
      removeClass(svg, "dragging-node");
      if (!p.dragging) return;
      var def = nodes[p.id];
      if (!def) return;
      var label = def.label;
      var nx = clampN(Math.round(def.x), 40, 600);
      var ny = clampN(Math.round(def.y), 40, 380);
      /* A drag is not a connect gesture: if this press armed a new
         selection, restore the pre-grab selection. An edge made on
         pointerdown is kept. */
      if (!p.connected) selected = p.selBefore;
      commitOp({ op: "move", node_id: p.id, x: nx, y: ny }, function () {
        localMove(p.id, nx, ny);
      });
      say(tx("moved") + ": " + label);
      var back = svg.querySelector('[data-node="' + p.id + '"]');
      if (back) {
        addClass(back, "settle");
        setTimeout(function () { removeClass(back, "settle"); }, 160);
      }
    }

    svg.addEventListener("pointerdown", function (evt) {
      closeMenu(false);
      if (evt.button !== undefined && evt.button !== 0) return;
      var target = evt.target && evt.target.closest ? evt.target.closest("[data-node]") : null;
      if (target) {
        var id = target.getAttribute("data-node");
        if (!nodes[id]) return;
        var pt = svgPoint(evt);
        var before = selected;
        activateNode(id);
        press = {
          id: id, sx: pt.x, sy: pt.y,
          cx: (evt.clientX || 0), cy: (evt.clientY || 0),
          selBefore: before,
          connected: !!(before && before !== id && selected === null),
          timer: null, dragging: false, menuOpened: false
        };
        /* Long-press (touch): 500ms opens the context menu. Any real
           movement cancels it and the gesture becomes a drag. */
        if (evt.pointerType === "touch" || evt.pointerType === "pen") {
          press.timer = setTimeout(function () {
            var q = press;
            if (!q || q.dragging || q.menuOpened || !nodes[q.id]) return;
            q.menuOpened = true;
            q.timer = null;
            openMenu(q.id, q.cx, q.cy, { x: nodes[q.id].x, y: nodes[q.id].y });
          }, LONG_PRESS_MS);
        }
        addDocMoveUp();
      } else {
        press = null;
        addNode(svgPoint(evt));
      }
    });

    svg.addEventListener("contextmenu", function (evt) {
      if (evt.preventDefault) evt.preventDefault();
      var target = evt.target && evt.target.closest ? evt.target.closest("[data-node]") : null;
      var pt = svgPoint(evt);
      if (target && nodes[target.getAttribute("data-node")]) {
        openMenu(target.getAttribute("data-node"), evt.clientX, evt.clientY, pt);
      } else {
        openMenu(null, evt.clientX, evt.clientY, pt);
      }
    });

    /* Double-click a node: inline rename. Double-click empty canvas:
       quick-add one node at that point. The two single taps that make up
       a real double-click each added a node on pointerdown; recentAdds
       prunes those so the gesture ends with exactly one node. */
    svg.addEventListener("dblclick", function (evt) {
      var target = evt.target && evt.target.closest ? evt.target.closest("[data-node]") : null;
      if (target && nodes[target.getAttribute("data-node")]) {
        startRename(target.getAttribute("data-node"));
        return;
      }
      var pt = svgPoint(evt);
      var now = Date.now();
      var pruned = false;
      recentAdds = recentAdds.filter(function (r) {
        if (now - r.t < 600 && nodes[r.id]) {
          delete nodes[r.id];
          pruned = true;
          return false;
        }
        return now - r.t < 600;
      });
      if (pruned) {
        edges = edges.filter(function (e) { return nodes[e.a] && nodes[e.b]; });
        if (selected && !nodes[selected]) selected = null;
      }
      var label = tx("untitled") || "Untitled node";
      commitOp({ op: "add_node", type: "collection", label: label }, function () {
        localAdd(pt, "collection", label);
      });
      say((T.added || "Added") + ": " + label);
    });

    /* --------------------------------------------------------------
       Context menu: floating panel, 14px radius, hairline border plus
       whisper shadow, 44px items, keyboard navigable, opens at the
       pointer clamped to the canvas wrap.
       -------------------------------------------------------------- */
    var openMenuRef = null;

    function menuHost() {
      return wrap || document.body;
    }
    function closeMenu(returnFocus) {
      var ref = openMenuRef;
      openMenuRef = null;
      if (!ref) return;
      if (ref.docDown && document.removeEventListener) {
        document.removeEventListener("pointerdown", ref.docDown, true);
      }
      detach(ref.menu);
      if (returnFocus) {
        var t = ref.nodeId ? svg.querySelector('[data-node="' + ref.nodeId + '"]') : null;
        if (t && t.focus) t.focus();
        else if (svg.focus) svg.focus();
      }
    }

    function menuButton(ref, key, label, opts) {
      opts = opts || {};
      var b = document.createElement("button");
      b.type = "button";
      b.className = "dm-mi" + (opts.danger ? " danger" : "");
      b.setAttribute("role", "menuitem");
      b.setAttribute("data-menu-key", key);
      if (opts.icon) b.appendChild(opts.icon);
      var s = document.createElement("span");
      s.textContent = label;
      b.appendChild(s);
      if (opts.hint) {
        var h = document.createElement("span");
        h.className = "dm-hint";
        h.textContent = opts.hint;
        b.appendChild(h);
      }
      b.addEventListener("click", function () { opts.act(); });
      ref.menu.appendChild(b);
      ref.items.push(b);
      return b;
    }

    /* Monochrome shape icons matching the node shapes (no emojis). */
    function kindIcon(type) {
      var s = document.createElementNS(NS, "svg");
      s.setAttribute("width", "18");
      s.setAttribute("height", "18");
      s.setAttribute("viewBox", "-12 -12 24 24");
      s.setAttribute("aria-hidden", "true");
      var e;
      if (type === "collection") {
        e = el("circle", { r: 7, fill: "none", stroke: "currentColor", "stroke-width": 2 });
      } else if (type === "system") {
        e = el("rect", { x: -8, y: -6, width: 16, height: 12, rx: 2, fill: "none", stroke: "currentColor", "stroke-width": 2 });
      } else if (type === "thirdparty") {
        e = el("polygon", { points: "0,-8 8,0 0,8 -8,0", fill: "none", stroke: "currentColor", "stroke-width": 2 });
      } else {
        e = el("g", {});
        e.appendChild(el("circle", { r: 7, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-dasharray": "3 2" }));
        e.appendChild(el("line", { x1: -4, y1: -4, x2: 4, y2: 4, stroke: "currentColor", "stroke-width": 2 }));
        e.appendChild(el("line", { x1: -4, y1: 4, x2: 4, y2: -4, stroke: "currentColor", "stroke-width": 2 }));
      }
      s.appendChild(e);
      return s;
    }

    function renderNodeMenu(ref, nodeId) {
      menuButton(ref, "rename", tx("menuRename"), {
        hint: tx("hintEnter"),
        act: function () { closeMenu(false); startRename(nodeId); }
      });
      menuButton(ref, "setup", tx("menuSetup"), {
        act: function () { closeMenu(false); openSetupPanel(nodeId); }
      });
      menuButton(ref, "type", tx("menuType"), {
        act: function () { showKindList(ref, { mode: "retype", nodeId: nodeId }); }
      });
      menuButton(ref, "flow", tx("menuFlow"), {
        act: function () { closeMenu(false); armFlow(nodeId); }
      });
      menuButton(ref, "remove", tx("menuRemove"), {
        hint: tx("hintDel"), danger: true,
        act: function () { closeMenu(false); confirmRemove(nodeId); }
      });
    }

    function renderEmptyMenu(ref, pt) {
      menuButton(ref, "addhere", tx("menuAddHere"), {
        act: function () { showKindList(ref, { mode: "add", pt: pt || { x: 320, y: 210 } }); }
      });
    }

    function showKindList(ref, opts) {
      while (ref.menu.firstChild) ref.menu.removeChild(ref.menu.firstChild);
      ref.items = [];
      ref.idx = 0;
      var head = document.createElement("div");
      head.className = "dm-menu-head";
      head.textContent = opts.mode === "add" ? tx("kindTitle") : tx("menuType");
      ref.menu.appendChild(head);
      DM_NODE_TYPES.forEach(function (t) {
        var current = opts.mode === "retype" && nodes[opts.nodeId] && nodes[opts.nodeId].type === t;
        var b = menuButton(ref, "kind:" + t, typeNames[t] || t, {
          icon: kindIcon(t),
          act: function () {
            if (opts.mode === "add") {
              var pt = opts.pt;
              var label = tx("untitled") || "Untitled node";
              commitOp({ op: "add_node", type: t, label: label }, function () {
                localAdd(pt, t, label);
              });
              say((T.added || "Added") + ": " + label);
            } else {
              commitOp({ op: "retype", node_id: opts.nodeId, type: t }, function () {
                localRetype(opts.nodeId, t);
              });
              var after = nodes[opts.nodeId];
              say(tx("typeSet") + (after ? ": " + after.label : ""));
            }
            closeMenu(true);
          }
        });
        if (current) {
          var c = document.createElement("span");
          c.className = "dm-check";
          c.textContent = "✓";
          b.appendChild(c);
        }
      });
      menuButton(ref, "kind-cancel", tx("kindCancel"), {
        act: function () { closeMenu(true); }
      });
      focusItem(ref, 0);
    }

    function placeMenu(menu, clientX, clientY) {
      var host = menuHost();
      host.appendChild(menu);
      var wr = (wrap && wrap.getBoundingClientRect) ? wrap.getBoundingClientRect() :
        { left: 0, top: 0, width: (window.innerWidth || 640), height: (window.innerHeight || 420) };
      var mw = menu.offsetWidth || 260;
      var mh = menu.offsetHeight || 320;
      var x = (clientX === undefined || clientX === null) ? wr.width / 2 : clientX - wr.left;
      var y = (clientY === undefined || clientY === null) ? wr.height / 2 : clientY - wr.top;
      x = Math.max(8, Math.min(x, Math.max(8, wr.width - mw - 8)));
      y = Math.max(8, Math.min(y, Math.max(8, wr.height - mh - 8)));
      menu.setAttribute("data-mx", Math.round(x));
      menu.setAttribute("data-my", Math.round(y));
      setPos(menu, x, y);
    }

    function focusItem(ref, i) {
      ref.idx = i;
      var b = ref.items[i];
      if (b && b.focus) b.focus();
    }

    function menuKey(ref, evt) {
      var k = evt.key;
      var n = ref.items.length;
      if (!n) return;
      if (k === "Escape") {
        if (evt.preventDefault) evt.preventDefault();
        closeMenu(true);
      } else if (k === "ArrowDown") {
        if (evt.preventDefault) evt.preventDefault();
        focusItem(ref, (ref.idx + 1) % n);
      } else if (k === "ArrowUp") {
        if (evt.preventDefault) evt.preventDefault();
        focusItem(ref, (ref.idx - 1 + n) % n);
      } else if (k === "Home") {
        if (evt.preventDefault) evt.preventDefault();
        focusItem(ref, 0);
      } else if (k === "End") {
        if (evt.preventDefault) evt.preventDefault();
        focusItem(ref, n - 1);
      }
    }

    function openMenu(nodeId, clientX, clientY, pt) {
      closeMenu(false);
      var menu = document.createElement("div");
      menu.className = "dm-menu";
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", nodeId ? tx("menuAria") : tx("emptyMenuAria"));
      var ref = { menu: menu, nodeId: nodeId || null, items: [], idx: 0, docDown: null };
      openMenuRef = ref;
      if (nodeId) renderNodeMenu(ref, nodeId);
      else renderEmptyMenu(ref, pt);
      placeMenu(menu, clientX, clientY);
      menu.addEventListener("keydown", function (evt) { menuKey(ref, evt); });
      /* Close on outside click. The capture listener walks up manually so
         it works even where Element.contains is unavailable. */
      ref.docDown = function (evt) {
        var t = evt.target;
        while (t) {
          if (t === menu) return;
          t = t.parentNode;
        }
        closeMenu(false);
      };
      if (document.addEventListener) document.addEventListener("pointerdown", ref.docDown, true);
      focusItem(ref, 0);
    }

    function openMenuForNode(id) {
      var def = nodes[id];
      if (!def) return;
      var r = svg.getBoundingClientRect();
      openMenu(id, r.left + (def.x / 640) * r.width, r.top + (def.y / 420) * r.height, { x: def.x, y: def.y });
    }

    /* --------------------------------------------------------------
       Inline rename editor: positioned over the node, Enter saves,
       Escape cancels, blur saves.
       -------------------------------------------------------------- */
    var renameRef = null;
    function positionEditor(elm, x, y) {
      var sr = svg.getBoundingClientRect();
      var host = menuHost();
      var hr = (host && host.getBoundingClientRect) ? host.getBoundingClientRect() : { left: 0, top: 0 };
      var sx = sr.width / 640, sy = sr.height / 420;
      var px = (sr.left - hr.left) + x * sx - 90;
      var py = (sr.top - hr.top) + y * sy - 22;
      setPos(elm, Math.max(4, px), Math.max(4, py));
    }
    function startRename(id) {
      var def = nodes[id];
      if (!def) return;
      closeMenu(false);
      closeRename();
      var host = menuHost();
      var input = document.createElement("input");
      input.type = "text";
      input.className = "dm-rename";
      input.value = def.label;
      input.setAttribute("aria-label", tx("renameAria"));
      input.setAttribute("data-rename-for", id);
      positionEditor(input, def.x, def.y);
      host.appendChild(input);
      var done = false;
      function finish(commit) {
        if (done) return;
        done = true;
        var v = input.value.trim();
        closeRename();
        if (commit && v && v !== def.label) {
          commitOp({ op: "relabel", node_id: id, label: v }, function () {
            localRelabel(id, v);
          });
          say(tx("renamed") + ": " + v);
        }
        var back = svg.querySelector('[data-node="' + id + '"]');
        if (back && back.focus) back.focus();
      }
      renameRef = { input: input, finish: finish };
      input.addEventListener("keydown", function (evt) {
        if (evt.key === "Enter") {
          if (evt.preventDefault) evt.preventDefault();
          finish(true);
        } else if (evt.key === "Escape") {
          if (evt.preventDefault) evt.preventDefault();
          finish(false);
        }
      });
      input.addEventListener("blur", function () { finish(true); });
      if (input.focus) input.focus();
      if (input.select) { try { input.select(); } catch (e) { /* best-effort */ } }
    }
    function closeRename() {
      if (renameRef) {
        var r = renameRef;
        renameRef = null;
        detach(r.input);
      }
    }

    /* --------------------------------------------------------------
       Setup editor: first offers the review panel a chance to open its
       own editor (dm:open-node-setup, cancelable); otherwise a compact
       inline panel writes set_meta (whitelisted string fields only).
       -------------------------------------------------------------- */
    var setupRef = null;
    function openSetupPanel(id) {
      var def = nodes[id];
      if (!def) return;
      var CE = typeof CustomEvent === "function" ? CustomEvent : null;
      var dispatched = false, canceled = false;
      if (CE && document.dispatchEvent) {
        try {
          var cev = new CE("dm:open-node-setup", {
            detail: { node_id: id, label: def.label, type: def.type },
            cancelable: true
          });
          dispatched = true;
          canceled = !document.dispatchEvent(cev);
        } catch (e) { /* fall through to the inline panel */ }
      }
      if (dispatched && canceled) return;
      closeMenu(false);
      closeSetup();
      var host = menuHost();
      var panel = document.createElement("div");
      panel.className = "dm-panel dm-setup";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", tx("setupTitle"));
      var h = document.createElement("h4");
      h.textContent = tx("setupTitle") + ": " + def.label;
      panel.appendChild(h);
      var fields = [
        { k: "notes", label: tx("setupNotes") },
        { k: "holds", label: tx("setupHolds") },
        { k: "why", label: tx("setupWhy") },
        { k: "region", label: tx("setupRegion") }
      ];
      var inputs = {};
      fields.forEach(function (f) {
        var w = document.createElement("div");
        w.className = "field";
        var lab = document.createElement("label");
        lab.textContent = f.label;
        var inp = document.createElement("input");
        inp.type = "text";
        inp.value = (def.meta && def.meta[f.k]) || "";
        inp.setAttribute("data-setup-field", f.k);
        lab.appendChild(inp);
        w.appendChild(lab);
        panel.appendChild(w);
        inputs[f.k] = inp;
      });
      var row = document.createElement("div");
      row.className = "dm-row";
      var saveB = document.createElement("button");
      saveB.type = "button";
      saveB.className = "btn";
      saveB.textContent = tx("setupSave");
      var cancelB = document.createElement("button");
      cancelB.type = "button";
      cancelB.className = "btn secondary";
      cancelB.textContent = tx("setupCancel");
      row.appendChild(saveB);
      row.appendChild(cancelB);
      panel.appendChild(row);
      positionEditor(panel, def.x, def.y);
      host.appendChild(panel);
      var done = false;
      function finish(commit) {
        if (done) return;
        done = true;
        closeSetup();
        if (commit) {
          var meta = {};
          Object.keys(inputs).forEach(function (k) { meta[k] = inputs[k].value.trim(); });
          commitOp({ op: "set_meta", node_id: id, meta: meta }, function () {
            localSetMeta(id, meta);
          });
          say(tx("setupSaved"));
        }
        var back = svg.querySelector('[data-node="' + id + '"]');
        if (back && back.focus) back.focus();
      }
      setupRef = { panel: panel, finish: finish, inputs: inputs };
      saveB.addEventListener("click", function () { finish(true); });
      cancelB.addEventListener("click", function () { finish(false); });
      panel.addEventListener("keydown", function (evt) {
        if (evt.key === "Escape") {
          if (evt.preventDefault) evt.preventDefault();
          finish(false);
        }
      });
      if (inputs.notes && inputs.notes.focus) inputs.notes.focus();
    }
    function closeSetup() {
      if (setupRef) {
        var r = setupRef;
        setupRef = null;
        detach(r.panel);
      }
    }

    /* --------------------------------------------------------------
       Remove with inline confirm (mirrors the wipe pattern: no native
       dialogs, works the same for humans and automation).
       -------------------------------------------------------------- */
    var confirmRef = null;
    function confirmRemove(id) {
      var def = nodes[id];
      if (!def) return;
      closeMenu(false);
      closeConfirm();
      var host = menuHost();
      var panel = document.createElement("div");
      panel.className = "dm-panel dm-confirm";
      panel.setAttribute("role", "alertdialog");
      panel.setAttribute("aria-label", tx("removeAsk"));
      var p = document.createElement("p");
      p.textContent = tx("removeAsk");
      panel.appendChild(p);
      var row = document.createElement("div");
      row.className = "dm-row";
      var yes = document.createElement("button");
      yes.type = "button";
      yes.className = "btn danger";
      yes.textContent = tx("removeYes");
      var keep = document.createElement("button");
      keep.type = "button";
      keep.className = "btn secondary";
      keep.textContent = tx("removeKeep");
      row.appendChild(yes);
      row.appendChild(keep);
      panel.appendChild(row);
      positionEditor(panel, def.x, def.y);
      host.appendChild(panel);
      var done = false;
      function finish(removeIt) {
        if (done) return;
        done = true;
        var label = def.label;
        closeConfirm();
        if (removeIt) {
          commitOp({ op: "remove_node", node_id: id }, function () {
            localRemove(id);
          });
          say(tx("removed") + ": " + label);
          if (svg.focus) svg.focus();
        } else {
          var back = svg.querySelector('[data-node="' + id + '"]');
          if (back && back.focus) back.focus();
        }
      }
      confirmRef = { panel: panel, finish: finish };
      yes.addEventListener("click", function () { finish(true); });
      keep.addEventListener("click", function () { finish(false); });
      panel.addEventListener("keydown", function (evt) {
        if (evt.key === "Escape") {
          if (evt.preventDefault) evt.preventDefault();
          finish(false);
        }
      });
      if (yes.focus) yes.focus();
    }
    function closeConfirm() {
      if (confirmRef) {
        var r = confirmRef;
        confirmRef = null;
        detach(r.panel);
      }
    }

    /* Arm tap-to-connect with this node as the source. */
    function armFlow(id) {
      if (!nodes[id]) return;
      selected = id;
      redraw();
      var back = svg.querySelector('[data-node="' + id + '"]');
      if (back && back.focus) back.focus();
      say(tx("flowArmed"));
    }

    /* --------------------------------------------------------------
       Keyboard: arrows move the focused node (Shift for larger steps),
       Shift+F10 / applications key opens the menu, Delete removes with
       confirm, Enter renames the selected node (or selects/connects),
       Escape closes the menu.
       -------------------------------------------------------------- */
    svg.addEventListener("keydown", function (evt) {
      var target = evt.target && evt.target.closest ? evt.target.closest("[data-node]") : null;
      if (!target) return;
      var id = target.getAttribute("data-node");
      var k = evt.key;
      if (k === "ArrowRight" || k === "ArrowLeft" || k === "ArrowUp" || k === "ArrowDown") {
        var def = nodes[id];
        if (!def) return;
        if (evt.preventDefault) evt.preventDefault();
        var step = evt.shiftKey ? 32 : 8;
        var nx = clampN(def.x + (k === "ArrowRight" ? step : k === "ArrowLeft" ? -step : 0), 40, 600);
        var ny = clampN(def.y + (k === "ArrowDown" ? step : k === "ArrowUp" ? -step : 0), 40, 380);
        commitOp({ op: "move", node_id: id, x: nx, y: ny }, function () {
          def.x = nx;
          def.y = ny;
        });
        say(tx("moved") + ": " + def.label);
        var back = svg.querySelector('[data-node="' + id + '"]');
        if (back && back.focus) back.focus();
        return;
      }
      if ((k === "F10" && evt.shiftKey) || k === "ContextMenu") {
        if (evt.preventDefault) evt.preventDefault();
        openMenuForNode(id);
        return;
      }
      if (k === "Delete" || k === "Backspace") {
        if (evt.preventDefault) evt.preventDefault();
        confirmRemove(id);
        return;
      }
      if (k === "Escape") {
        closeMenu(true);
        return;
      }
      if (k === "Enter") {
        if (evt.preventDefault) evt.preventDefault();
        if (selected === id) {
          startRename(id);
        } else {
          activateNode(id);
          var back2 = svg.querySelector('[data-node="' + id + '"]');
          if (back2) back2.focus();
        }
        return;
      }
      if (k === " ") {
        if (evt.preventDefault) evt.preventDefault();
        activateNode(id);
        var back3 = svg.querySelector('[data-node="' + id + '"]');
        if (back3) back3.focus();
      }
    });

    /* Fit to screen: the viewBox is fixed, so this resets any caller-set
       view and brings the canvas back into view. The map can never be
       lost behind a stale zoom. */
    var fitBtn = document.createElement("button");
    fitBtn.type = "button";
    fitBtn.className = "dm-fit";
    fitBtn.textContent = tx("fitScreen");
    fitBtn.setAttribute("aria-label", tx("fitScreen"));
    fitBtn.addEventListener("click", function () {
      window.DMImport.setView({ viewBox: "0 0 640 420" });
      say(tx("fitDone"));
      if (wrap && wrap.scrollIntoView) {
        try { wrap.scrollIntoView({ block: "nearest" }); } catch (e) { /* best-effort */ }
      }
      if (fitBtn.focus) fitBtn.focus();
    });
    var fitHost = wrap || (svg.parentNode || document.body);
    if (fitHost && fitHost.appendChild) fitHost.appendChild(fitBtn);

    if (delBtn) delBtn.addEventListener("click", function () {
      if (!selected || !nodes[selected]) { say(T.nothingSel || "Nothing selected."); return; }
      var label = nodes[selected].label;
      delete nodes[selected];
      edges = edges.filter(function (e) { return e.a !== selected && e.b !== selected; });
      selected = null;
      markDirty();
      redraw();
      say((T.deleted || "Deleted") + ": " + label);
    });

    /* One-click wipe, confirmed inline. Native window.confirm is not used:
       automation (and the managed browser QA) auto-dismisses native
       dialogs, which silently aborted the wipe and left every node, card,
       and meta field in place. The inline confirm works the same for a
       human and for automation. Confirming also tears down the assistant
       session (review cards, executor state including meta, panels) so a
       later review action cannot repaint the cleared canvas from stale
       state. */
    if (wipeBtn) wipeBtn.addEventListener("click", function () {
      if (!Object.keys(nodes).length) return;
      if (wipeBtn.parentNode.querySelector(".bn-wipebox")) return;
      wipeBtn.hidden = true;
      var box = document.createElement("span");
      box.className = "bn-wipebox";
      box.setAttribute("role", "group");
      box.setAttribute("aria-label", T.wipeAsk || "Wipe the canvas? This cannot be undone.");
      var ask = document.createElement("span");
      ask.className = "bn-wipeask";
      ask.textContent = T.wipeAsk || "Wipe the canvas? This cannot be undone.";
      var yes = document.createElement("button");
      yes.type = "button";
      yes.className = "btn danger bn-wipeyes";
      yes.textContent = T.wipeYes || "Yes, wipe it";
      var keep = document.createElement("button");
      keep.type = "button";
      keep.className = "btn bn-wipekeep";
      keep.textContent = T.wipeKeep || "Keep it";
      function closeBox(restoreFocus) {
        box.remove();
        wipeBtn.hidden = false;
        if (restoreFocus) wipeBtn.focus();
      }
      yes.addEventListener("click", function () {
        nodes = {}; edges = []; selected = null; dirty = false; recentAdds = [];
        redraw();
        say(T.wiped || "Canvas cleared.");
        closeBox(false);
        try {
          if (window.__s1ExternalWipe) window.__s1ExternalWipe();
        } catch (e) { /* assistant teardown is best-effort */ }
        wipeBtn.focus();
      });
      keep.addEventListener("click", function () { closeBox(true); });
      box.addEventListener("keydown", function (evt) {
        if (evt.key === "Escape") { evt.preventDefault(); closeBox(true); }
      });
      box.appendChild(ask);
      box.appendChild(yes);
      box.appendChild(keep);
      wipeBtn.parentNode.insertBefore(box, wipeBtn.nextSibling);
      yes.focus();
    });

    function inventoryRows() {
      var nodeRows = Object.keys(nodes).map(function (id) {
        var n = nodes[id];
        return [n.label, typeNames[n.type] || n.type];
      });
      var edgeRows = edges.map(function (e) {
        var A = nodes[e.a], B = nodes[e.b];
        return [(A && A.label) || e.a, (B && B.label) || e.b, catNames[e.cat] || e.cat];
      });
      return { nodeRows: nodeRows, edgeRows: edgeRows };
    }

    /* Print / PDF: render an inventory sheet into a print-only section,
       print it, then clean up. The sheet carries the legal framing. */
    if (printBtn) printBtn.addEventListener("click", function () {
      if (!Object.keys(nodes).length) { say(T.nothingSel || "Nothing selected."); return; }
      var sheet = document.getElementById("builder-print-sheet");
      var inv = inventoryRows();
      var when = new Date().toLocaleString();
      var html = "<h2>" + esc(T.printTitle || "Data map inventory") + "</h2>" +
        '<p class="ps-meta">' + esc((T.printGenerated || "Generated client-side") + " · " + when) + "</p>";
      sheet.innerHTML = html;
      var clone = svg.cloneNode(true);
      clone.removeAttribute("id");
      clone.setAttribute("width", "640");
      clone.setAttribute("height", "420");
      clone.removeAttribute("tabindex");
      sheet.appendChild(clone);
      function table(caption, headers, rows) {
        var h = "<h2>" + esc(caption) + "</h2><table><tr>" +
          headers.map(function (x) { return "<th>" + esc(x) + "</th>"; }).join("") + "</tr>" +
          rows.map(function (r) {
            return "<tr>" + r.map(function (x) { return "<td>" + esc(x) + "</td>"; }).join("") + "</tr>";
          }).join("") + "</table>";
        var d = document.createElement("div");
        d.innerHTML = h;
        return d;
      }
      sheet.appendChild(table((T.xlsNodes || "Nodes") + " (" + inv.nodeRows.length + ")", T.xlsNodeH || ["Label", "Type"], inv.nodeRows));
      sheet.appendChild(table((T.xlsConns || "Connections") + " (" + inv.edgeRows.length + ")", T.xlsEdgeH || ["From", "To", "Category"], inv.edgeRows));
      var fine = document.createElement("p");
      fine.className = "ps-fine";
      fine.textContent = T.checkpointDisclaimer || "Illustrative working draft only. Not legal advice; verify retention obligations independently.";
      sheet.appendChild(fine);
      document.documentElement.classList.add("printing-builder");
      window.print();
    });
    window.addEventListener("afterprint", function () {
      document.documentElement.classList.remove("printing-builder");
    });

    /* Excel: genuine multi-sheet .xls via SpreadsheetML (opens in Excel,
       LibreOffice, Numbers). No libraries, no network, all client-side. */
    function xlsCell(v, style) {
      v = String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return '<Cell' + (style ? ' ss:StyleID="' + style + '"' : "") + '><Data ss:Type="String">' + v + "</Data></Cell>";
    }
    function xlsSheet(name, headers, rows, leading) {
      var h = "<Row>" + headers.map(function (x) { return xlsCell(x, "h"); }).join("") + "</Row>";
      var b = rows.map(function (r) {
        return "<Row>" + r.map(function (x) { return xlsCell(x); }).join("") + "</Row>";
      }).join("");
      var lead = (leading || []).map(function (r) {
        return "<Row>" + r.map(function (x) { return xlsCell(x); }).join("") + "</Row>";
      }).join("");
      return '<Worksheet ss:Name="' + String(name).replace(/[<>&"]/g, "") +
        '"><Table>' + lead + h + b + "</Table></Worksheet>";
    }
    if (xlsBtn) xlsBtn.addEventListener("click", function () {
      if (!Object.keys(nodes).length) { say(T.nothingSel || "Nothing selected."); return; }
      var inv = inventoryRows();
      var framing = [
        [T.checkpointDisclaimer || "Illustrative working draft only. Not legal advice; verify retention obligations independently."],
        [""]
      ];
      var doc = '<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>' +
        '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
        '<Styles><Style ss:ID="h"><Font ss:Bold="1"/><Interior ss:Color="#EFE9DA" ss:Pattern="Solid"/></Style></Styles>' +
        xlsSheet(T.xlsNodes || "Nodes", T.xlsNodeH || ["Label", "Type"], inv.nodeRows, framing) +
        xlsSheet(T.xlsConns || "Connections", T.xlsEdgeH || ["From", "To", "Category"], inv.edgeRows) +
        "</Workbook>";
      var blob = new Blob(["\uFEFF" + doc], { type: "application/vnd.ms-excel;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "data-map-inventory.xls";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      say(T.xlsDone || "Excel file downloaded.");
    });

    if (saveBtn) saveBtn.addEventListener("click", function () {
      var data = {
        tool: "data-map-checkpoint", version: 1,
        exportedAt: new Date().toISOString(),
        disclaimer: T.checkpointDisclaimer || "Illustrative working draft only. Not legal advice; verify retention obligations independently.",
        nodes: nodes, edges: edges
      };
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "data-map-checkpoint.json";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      dirty = false;
      say(T.saved || "Checkpoint saved as JSON.");
    });

    if (loadIn) loadIn.addEventListener("change", function () {
      var f = loadIn.files && loadIn.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          var data = JSON.parse(r.result);
          if (!data.nodes) throw new Error("bad file");
          nodes = data.nodes; edges = data.edges || []; selected = null;
          recentAdds = [];
          seq = Object.keys(nodes).length;
          markDirty();
          redraw();
          say(T.loaded || "Checkpoint loaded.");
        } catch (err) { say(T.loadFail || "Could not read that file."); }
      };
      r.readAsText(f);
      loadIn.value = "";
    });

    say(T.hint || "Tap the canvas to add a node. Tap one node, then another, to connect them.");
    redraw();

    /* Assistant seam (window.DMImport): applyState/getView/setView over
       the builder's own state and redraw machinery, so an
       assistant-painted map looks identical to a hand-built one.
       applyState never touches the viewBox (the caller preserves the
       view around it). Queued states from before unlock land here on
       boot. */
    canvasApi = {
      applyState: function (norm) {
        nodes = norm.nodes;
        edges = norm.edges;
        selected = null;
        recentAdds = [];
        /* Keep hand-added node ids unique after an assistant run: continue
           the sequence past the highest numeric node suffix. */
        var max = 0;
        Object.keys(nodes).forEach(function (id) {
          var m = /^n(\d+)$/.exec(id);
          if (m) max = Math.max(max, parseInt(m[1], 10));
        });
        seq = Math.max(seq, max);
        redraw();
      },
      getView: function () {
        return { viewBox: svg.getAttribute("viewBox") || "0 0 640 420" };
      },
      setView: function (view) {
        if (view && view.viewBox) svg.setAttribute("viewBox", view.viewBox);
      }
    };
    if (pendingState) {
      var queued = pendingState;
      pendingState = null;
      canvasApi.applyState(queued);
    }

    /* Test and integration hooks (not part of the shipped UI). */
    window.DMInteract = {
      ops: committedOps,
      constants: {
        longPressMs: LONG_PRESS_MS,
        moveCancelPx: MOVE_CANCEL_PX,
        dragStartPx: DRAG_START_PX,
        snapPx: SNAP_PX
      },
      pressActive: function () { return !!press; },
      longPressArmed: function () { return !!(press && press.timer); },
      menuOpen: function () { return !!openMenuRef; },
      menuNode: function () { return openMenuRef ? openMenuRef.nodeId : null; },
      openMenu: openMenu,
      closeMenu: closeMenu,
      i18n: I18N_DEFAULTS
    };
  }
})();
