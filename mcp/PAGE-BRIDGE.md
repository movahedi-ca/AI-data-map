# Page bridge snippet (optional, not wired by default)

This snippet streams executor step events from the data-mapping guide page
to the Phase 7 MCP HTTP bridge. It is **optional and disabled by default**:
nothing posts anywhere unless the operator sets a localStorage key first.
The default tool page keeps zero external requests.

To enable, open the browser console on the guide page and run:

```js
localStorage.setItem("s1mcp_ingest_url", "http://127.0.0.1:8787");
```

Then start the bridge:

```bash
AI_DATA_MAP_BRIDGE_PORT=8787 node mcp/http-bridge.js
```

To disable again: `localStorage.removeItem("s1mcp_ingest_url")`.

## Snippet

Paste once on the executor page (console, or a bookmarklet). It polls the
Phase 7 hooks (`window.__s1executor`, EXECUTOR-API.md) every 500 ms and
POSTs each new trace step as `{action, narration_en, narration_fr,
done_heads, terminal}`.

```html
<script>
(function () {
  var base = localStorage.getItem("s1mcp_ingest_url");
  if (!base || !window.__s1executor) return;
  var hooks = window.__s1executor, seen = -1;
  setInterval(function () {
    var st = hooks.state(); if (!st) return;
    var tr = hooks.trace(); if (!tr || !tr.steps) return;
    tr.steps.forEach(function (s, i) {
      if (i <= seen) return; seen = i;
      var n = window.S1Narrate || null;
      var body = JSON.stringify({
        action: s.action_name,
        narration_en: n ? n.narrate(s.action_name, {}, "en") : "",
        narration_fr: n ? n.narrate(s.action_name, {}, "fr") : "",
        done_heads: tr.done_heads || {},
        terminal: !!st.done
      });
      fetch(base + "/sessions/" + encodeURIComponent(st.session_id) + "/steps", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: body
      }).catch(function () { /* bridge down; the run continues locally */ });
    });
  }, 500);
})();
</script>
```

## Notes

- The snippet never reads or posts recipe contents, only step results.
- If the bridge is down, the `.catch` swallows the failure and the run
  continues locally; nothing in the executor depends on the bridge.
- When the stdio server runs with `AI_DATA_MAP_BRIDGE_PORT` set, the
  bridge shares its session store, so the stdio `get_session` returns the
  POSTed step events. In standalone bridge mode, read the record with
  `GET /sessions/:id` on the bridge instead.
