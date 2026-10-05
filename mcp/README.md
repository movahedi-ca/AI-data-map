# AI-data-map MCP server (Phase 7)

The nervous system of the Taiga-style data-mapping agent. This server
implements the Section 2 playbook contract:

- `execute_mapping_workflow(recipe)` validates the recipe against
  `specs/recipe-schema.json` and the intent names in
  `specs/action-catalogue.json`, then returns a **session ticket**.
- The **in-page executor** (`web/executor/`) runs the ticketed session:
  the System-1 model picks each action, narrations stream in EN/FR, and
  the run pauses at review flags. The server never executes a recipe.
- `get_session` returns the ticket plus any step events the page streamed
  back. `cancel_session` cancels a ticketed session.

Honest statement: model execution happens in the page per the contract.
The server validates, tickets, tracks, and cancels. It makes no network
calls except serving its own bridge endpoints.

## Files

| File | What it is |
|---|---|
| `server.js` | MCP server over stdio (JSON-RPC 2.0: `initialize`, `tools/list`, `tools/call`) |
| `http-bridge.js` | Optional stdlib HTTP bridge: page posts step events, MCP clients read them over SSE |
| `PAGE-BRIDGE.md` | The optional 30-line page snippet (not wired into demo pages by default) |
| `openapi.yaml` | OpenAPI 3.1 for the bridge plus JSON-schema for the tool input/output |
| `test-contract.js` | stdlib-only contract test: spawns the server over stdio, asserts ticket/error shapes |
| `package.json` | Name, version, bins. No dependencies |

## stdio usage with an MCP client

```bash
node /path/to/ai-data-map/mcp/server.js
```

The client sends one JSON-RPC 2.0 object per line on stdin and reads one
per line on stdout. Minimal handshake:

```jsonc
// client -> server
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"demo","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
// server -> client
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"ai-data-map-mcp","version":"1.0.0"}}}
```

Call the tool:

```jsonc
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"execute_mapping_workflow","arguments":{"recipe":{ ... }}}}
```

Success reply (content is JSON text):

```json
{
  "ok": true,
  "session_id": "s1-a3f9c21be04d",
  "recipe_id": "cafe-nord-sample-01",
  "item_count": 3,
  "status": "ticketed",
  "deep_link": "https://movahedi.ca/tools/data-mapping-guide/?ticket=s1-a3f9c21be04d"
}
```

`session_id` is `s1-` plus 12 hex chars of
`sha256(recipe_id + NUL + Date.now())`. Every call mints a fresh ticket,
even for the same recipe; validation itself is deterministic (the same
invalid recipe fails at the same item with the same reason every run).

## Error contract

Validation failures return the plain-language error contract from the
playbook Section 2 row:

```json
{
  "ok": false,
  "failed_item_index": 2,
  "reason": "items[2]: intent \"add_nod\" is unknown...",
  "partial_state": null,
  "recovery_hint": "Fix item 2 in the recipe (or drop it if it is not needed) and call execute_mapping_workflow again with the corrected recipe."
}
```

`failed_item_index` is `null` for recipe-level failures (bad `recipe_id`,
bad `schema_version`, empty items, over the size limits).

## Limits

- At most **200 items** per recipe.
- At most **64KB** of serialized recipe JSON (`JSON.stringify`, UTF-8 bytes).
- At most **4096 bytes** of serialized params per item (mirrors the Phase 0
  frozen limit in `specs/recipe-schema.json`).
- Over-limit recipes are rejected with a plain message, never truncated.
- `schema_version` must match `1.0.x`. `recipe_id` must match
  `^[A-Za-z0-9_-]+$` (1-128 chars).
- Executor-only recovery intents (`undo_last`, `skip_recipe_item`,
  `abort_session`) are known to the action catalogue but are rejected in
  recipes; they run in the page only.

## Sessions

- `get_session({session_id})` returns `{session_id, recipe_id, item_count,
  status, results}`. `results` holds step events the page POSTed to the
  bridge (`{action, narration_en, narration_fr, done_heads, terminal}`);
  a freshly ticketed session reports `status: "ticketed"` with `results: []`.
- `cancel_session({session_id})` returns `{session_id, status: "cancelled"}`.
  Cancelling an unknown, already cancelled, or finished session returns a
  clean JSON-RPC error, never a crash.
- Sessions live in server memory; restarting the server drops them. This
  is deliberate for Phase 7 (no database, no persistence surface).

## HTTP bridge

```bash
AI_DATA_MAP_BRIDGE_PORT=8787 node /path/to/ai-data-map/mcp/http-bridge.js
```

Listens on 127.0.0.1 only.

- `POST /sessions/:id/steps` with `{action, narration_en, narration_fr,
  done_heads, terminal}` ingests one step event; a `terminal: true` event
  marks the session finished. Unknown session ids are created lazily as
  standalone streaming sessions (the page can stream with only the bridge
  URL configured; see PAGE-BRIDGE.md).
- `GET /sessions/:id` returns the session record.
- `GET /sessions/:id/stream` is an SSE feed of step events.

Shared-store mode: set `AI_DATA_MAP_BRIDGE_PORT` when starting the stdio
server and it mounts the bridge in-process against its own session store:

```bash
AI_DATA_MAP_BRIDGE_PORT=8787 node /path/to/ai-data-map/mcp/server.js
```

In this mode the step events the page POSTs appear in the stdio
`get_session` results, exactly per the Section 2 contract. Run standalone,
the bridge keeps its own record and `GET /sessions/:id` is the way to read
streamed results.

## Testing

```bash
node /path/to/ai-data-map/mcp/test-contract.js
```

Expected: all assertions green, server exits 0.
