/* v3 – blank-canvas builder. Client-side only: nothing leaves the browser.
   T&C gate on first open (sessionStorage). Tap-to-connect, checkpoint save/load,
   one-click wipe, beforeunload guard while dirty. */
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
     The builder sits behind the T&C gate: if the gate has not opened the
     canvas yet, applyState queues the state and it is applied when the
     canvas initializes, so no step's output is lost. Nodes/edges render
     through the builder's own shapeFor/redraw machinery, so an
     assistant-painted map looks identical to a hand-built one.
     ------------------------------------------------------------------ */
  var canvasApi = null;    /* set by initCanvas when the canvas boots */
  var pendingState = null; /* queued while the gate is still closed */

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

  var gate = document.getElementById("builder-gate");
  var app = document.getElementById("builder-app");
  var gateCheck = document.getElementById("gate-check");
  var gateBtn = document.getElementById("gate-open");
  if (!gate || !app) return;

  if (sessionStorage.getItem("dm-gate-ok") === "1") { showApp(); }
  gateBtn.addEventListener("click", function () {
    if (!gateCheck.checked) {
      gateCheck.focus();
      return;
    }
    sessionStorage.setItem("dm-gate-ok", "1");
    showApp();
  });

  function showApp() {
    gate.hidden = true;
    app.hidden = false;
    initCanvas();
  }

  function initCanvas() {
    var svg = document.getElementById("builder-canvas");
    var typeSel = document.getElementById("bn-type");
    var labelIn = document.getElementById("bn-label");
    var catSel = document.getElementById("bn-cat");
    var addBtn = document.getElementById("bn-add");
    var delBtn = document.getElementById("bn-delete");
    var wipeBtn = document.getElementById("bn-wipe");
    var saveBtn = document.getElementById("bn-save");
    var loadIn = document.getElementById("bn-load");
    var printBtn = document.getElementById("bn-print");
    var xlsBtn = document.getElementById("bn-xls");
    var status = document.getElementById("builder-status");

    /* Localized human-readable names for canvas chrome: the selects'
       option text is already localized in the page HTML, so aria-labels
       and status lines reuse it instead of raw English ids ("thirdparty"
       is not a word in any language). */
    var typeNames = optionNames(typeSel);
    var catNames = optionNames(catSel);

    var nodes = {};   // id -> {type, x, y, label}
    var edges = [];   // {a, b, cat}
    var seq = 0;
    var selected = null;
    var dirty = false;

    svg.setAttribute("viewBox", "0 0 640 420");
    svg.setAttribute("role", "application");
    svg.setAttribute("aria-label", T.canvasLabel || "Blank mapping canvas");

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

    function shapeFor(id, def) {
      var g = el("g", { "class": "node" + (selected === id ? " selected" : ""), transform: "translate(" + def.x + "," + def.y + ")", "data-node": id, tabindex: "0", role: "button", "aria-label": (typeNames[def.type] || def.type) + ": " + def.label });
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
      var label = (labelIn.value || "").trim() || (T.untitled || "Untitled node");
      var id = "n" + (++seq);
      nodes[id] = { type: typeSel.value, x: pt.x, y: pt.y, label: label };
      labelIn.value = "";
      markDirty();
      redraw();
      say((T.added || "Added") + ": " + label);
    }

    addBtn.addEventListener("click", function () { addNode({ x: 120 + (seq * 70) % 400, y: 120 + (seq * 53) % 180 }); });

    function activateNode(id) {
      if (selected && selected !== id) {
        var cat = catSel.value;
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

    svg.addEventListener("keydown", function (evt) {
      var target = evt.target.closest ? evt.target.closest("[data-node]") : null;
      if (target && (evt.key === "Enter" || evt.key === " ")) {
        evt.preventDefault();
        var id = target.getAttribute("data-node");
        activateNode(id);
        var back = svg.querySelector('[data-node="' + id + '"]');
        if (back) back.focus();
      }
    });

    svg.addEventListener("pointerdown", function (evt) {
      var target = evt.target.closest ? evt.target.closest("[data-node]") : null;
      if (target) {
        activateNode(target.getAttribute("data-node"));
      } else {
        addNode(svgPoint(evt));
      }
    });

    delBtn.addEventListener("click", function () {
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
    wipeBtn.addEventListener("click", function () {
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
        nodes = {}; edges = []; selected = null; dirty = false;
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

    function optionNames(sel) {
      var map = {};
      for (var i = 0; i < sel.options.length; i++) map[sel.options[i].value] = sel.options[i].text;
      return map;
    }
    function inventoryRows() {
      var typeName = optionNames(typeSel), catName = optionNames(catSel);
      var nodeRows = Object.keys(nodes).map(function (id) {
        var n = nodes[id];
        return [n.label, typeName[n.type] || n.type];
      });
      var edgeRows = edges.map(function (e) {
        var A = nodes[e.a], B = nodes[e.b];
        return [(A && A.label) || e.a, (B && B.label) || e.b, catName[e.cat] || e.cat];
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
      // leading: framing rows (e.g. the disclaimer) that must precede the
      // header, per the frozen exporter format (freeze section 5).
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

    saveBtn.addEventListener("click", function () {
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

    loadIn.addEventListener("change", function () {
      var f = loadIn.files && loadIn.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          var data = JSON.parse(r.result);
          if (!data.nodes) throw new Error("bad file");
          nodes = data.nodes; edges = data.edges || []; selected = null;
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
       view around it). Queued states from before the gate opened land
       here on boot. */
    canvasApi = {
      applyState: function (norm) {
        nodes = norm.nodes;
        edges = norm.edges;
        selected = null;
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
  }
})();
