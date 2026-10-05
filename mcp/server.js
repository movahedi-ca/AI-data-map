#!/usr/bin/env node
"use strict";
/*
 * AI-data-map Phase 7 MCP server (stdio).
 *
 * Implements the Section 2 playbook contract: execute_mapping_workflow(recipe)
 * validates the recipe against the recipe schema and the action catalogue,
 * then returns a session ticket. Model execution happens in the page per the
 * contract; this server validates, tickets, tracks, and cancels. It never
 * makes network calls.
 *
 * Protocol: MCP over stdio, JSON-RPC 2.0, one JSON object per line.
 * Node standard library only.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TOOL_VERSION = "1.0.0";
const MCP_VERSIONS = ["2025-03-26", "2024-11-05"];
const MAX_ITEMS = 200; // Phase 7 MCP limit (Phase 0 schema allows 512)
const MAX_JSON_BYTES = 64 * 1024; // 64KB serialized recipe
const MAX_PARAMS_BYTES = 4096; // per item, mirrors recipe-schema size_limits
const RECIPE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SCHEMA_VERSION_RE = /^1\.0\.\d+$/;

// Recovery intents are executor-only: known to the catalogue, but a recipe
// must not reference them (RECIPE-VOCABULARY.md, Recipe-level rules).
const RECOVERY_INTENTS = new Set(["undo_last", "skip_recipe_item", "abort_session"]);

// ---------------------------------------------------------------------------
// Catalogue and shape rules
// ---------------------------------------------------------------------------

function repoRoot() {
  return path.resolve(__dirname, "..");
}

function knownIntents() {
  // The action catalogue is the source of truth for known intent names.
  const raw = fs.readFileSync(path.join(repoRoot(), "specs", "action-catalogue.json"), "utf8");
  const cat = JSON.parse(raw);
  return new Set(cat.actions.map((a) => a.name));
}

const INTENT_RULES = {
  add_node: {
    required: ["node_id", "type", "x", "y", "label"],
    check(p, at) {
      return (
        checkNodeId(p, at) ||
        checkEnum(p, "type", ["collection", "system", "thirdparty", "destruction"], at) ||
        checkCoord(p, "x", 40, 600, at) ||
        checkCoord(p, "y", 40, 380, at) ||
        checkLabel(p, at)
      );
    },
  },
  add_collection_point: {
    required: ["node_id", "x", "y", "label"],
    check(p, at) {
      return (
        checkNodeId(p, at) ||
        checkCoord(p, "x", 40, 600, at) ||
        checkCoord(p, "y", 40, 380, at) ||
        checkLabel(p, at)
      );
    },
  },
  connect: {
    required: ["a", "b", "cat"],
    check(p, at) {
      const idRe = /^n[1-9]\d*$/;
      if (typeof p.a !== "string" || !idRe.test(p.a)) return fail(at, 'connect: "a" must match ^n[1-9][0-9]*$');
      if (typeof p.b !== "string" || !idRe.test(p.b)) return fail(at, 'connect: "b" must match ^n[1-9][0-9]*$');
      if (p.a === p.b) return fail(at, "connect: self-loop is not allowed (a and b must differ)");
      return checkEnum(p, "cat", ["contact", "payment", "marketing"], at);
    },
  },
  set_field: {
    required: ["node_id", "field", "value"],
    check(p, at) {
      return (
        checkNodeId(p, at) ||
        checkEnum(p, "field", ["label", "x", "y"], at) ||
        (() => {
          if (p.field === "label") {
            if (typeof p.value !== "string" || p.value.length < 1 || p.value.length > 200)
              return fail(at, "set_field: value for label must be a string of 1 to 200 characters");
          } else if (p.field === "x") {
            if (typeof p.value !== "number" || p.value < 40 || p.value > 600)
              return fail(at, "set_field: value for x must be a number in [40, 600]");
          } else if (p.field === "y") {
            if (typeof p.value !== "number" || p.value < 40 || p.value > 380)
              return fail(at, "set_field: value for y must be a number in [40, 380]");
          }
          return null;
        })()
      );
    },
  },
  set_retention: {
    required: ["node_id", "record_type", "as_of"],
    check(p, at) {
      if (!/^n[1-9]\d*$/.test(p.node_id)) return fail(at, 'set_retention: "node_id" must match ^n[1-9][0-9]*$');
      if (typeof p.record_type !== "string" || p.record_type.length < 1 || p.record_type.length > 120)
        return fail(at, "set_retention: record_type must be 1 to 120 characters");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.as_of) || !isPastOrToday(p.as_of))
        return fail(at, "set_retention: as_of must be a real calendar date YYYY-MM-DD, not in the future");
      if (p.verify_only === true) return null;
      if (p.verify_only !== undefined && typeof p.verify_only !== "boolean")
        return fail(at, "set_retention: verify_only must be a boolean when present");
      if (typeof p.range_min_years !== "number" || !(p.range_min_years > 0))
        return fail(at, "set_retention: range_min_years must be a positive number (or use verify_only: true)");
      if (typeof p.range_max_years !== "number" || !(p.range_max_years > p.range_min_years))
        return fail(at, "set_retention: range_max_years must be a number greater than range_min_years");
      return checkStatute(p, at);
    },
  },
  run_check: {
    required: ["checks"],
    check(p, at) {
      const allowed = ["label_coverage", "connectivity", "retention_cited", "edge_categories"];
      if (!Array.isArray(p.checks) || p.checks.length < 1)
        return fail(at, "run_check: checks must be a non-empty array");
      if (new Set(p.checks).size !== p.checks.length)
        return fail(at, "run_check: checks must be unique");
      for (const c of p.checks)
        if (!allowed.includes(c)) return fail(at, `run_check: unknown check "${c}"`);
      return null;
    },
  },
  export: {
    required: ["format"],
    check(p, at) {
      if (p.format !== "xls") return fail(at, 'export: format must be "xls"; no silent fallback to another format');
      return null;
    },
  },
  confirm_node: {
    required: ["node_id"],
    check(p, at) {
      return (
        checkNodeId(p, at) ||
        (p.note !== undefined && (typeof p.note !== "string" || p.note.length > 500)
          ? fail(at, "confirm_node: note must be a string of at most 500 characters")
          : null)
      );
    },
  },
  flag_for_review: {
    required: ["reason"],
    check(p, at) {
      if (typeof p.reason !== "string" || p.reason.length < 1 || p.reason.length > 500)
        return fail(at, "flag_for_review: reason must be 1 to 500 characters");
      if (p.node_id === undefined && p.item_index === undefined)
        return fail(at, "flag_for_review: at least one of node_id or item_index is required");
      if (p.node_id !== undefined && !/^n[1-9]\d*$/.test(p.node_id))
        return fail(at, 'flag_for_review: "node_id" must match ^n[1-9][0-9]*$');
      if (p.item_index !== undefined && (!Number.isInteger(p.item_index) || p.item_index < 0))
        return fail(at, "flag_for_review: item_index must be an integer >= 0");
      return null;
    },
  },
};

function checkNodeId(p, at) {
  if (typeof p.node_id !== "string" || !/^n[1-9]\d*$/.test(p.node_id))
    return fail(at, 'node_id must match ^n[1-9][0-9]*$ (e.g. "n1")');
  return null;
}
function checkEnum(p, key, values, at) {
  if (!values.includes(p[key])) return fail(at, `"${key}" must be one of: ${values.join(", ")}`);
  return null;
}
function checkCoord(p, key, lo, hi, at) {
  if (typeof p[key] !== "number" || p[key] < lo || p[key] > hi)
    return fail(at, `"${key}" must be a number in [${lo}, ${hi}] (no silent clamping)`);
  return null;
}
function checkLabel(p, at) {
  if (typeof p.label !== "string" || p.label.length < 1 || p.label.length > 200)
    return fail(at, "label must be a string of 1 to 200 characters");
  return null;
}
function fail(at, reason) {
  return { failed_item_index: at, reason };
}

function isPastOrToday(s) {
  const d = new Date(s + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) return false;
  const parts = s.split("-").map(Number);
  if (d.getUTCFullYear() !== parts[0] || d.getUTCMonth() + 1 !== parts[1] || d.getUTCDate() !== parts[2])
    return false;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return d.getTime() <= todayUtc;
}

const SECTION_RE = /([Ss][Ss]?\.?\s*[0-9]+|[Aa][Rr][Tt]\.?\s*[0-9]+|[Aa][Rr][Tt][Ii][Cc][Ll][Ee]\s+[0-9]+|[Rr]\.?\s*[0-9]+(\.[0-9]+)*|§\s*[0-9]+)/;
const LAW25_RE = /([Ll][Aa][Ww]\s*25|[Ll][Oo][Ii]\s*25|[Bb][Ii][Ll][Ll]\s*64|[Ll][Pp][Rr][Pp][Ss][Pp]|[Mm][Oo][Dd][Ee][Rr][Nn][Ii][Ss][Aa][Nn][Tt]|[Rr][Ee][Nn][Ss][Ee][Ii][Gg][Nn][Ee][Mm][Ee][Nn][Tt][Ss]\s+[Pp][Ee][Rr][Ss][Oo][Nn][Nn][Ee][Ll][Ss])/;

function checkStatute(p, at) {
  if (typeof p.statute !== "string" || p.statute.length < 8 || p.statute.length > 300)
    return fail(at, "set_retention: statute must be 8 to 300 characters");
  if (LAW25_RE.test(p.statute))
    return fail(at, "set_retention: Law 25 sets no retention periods; it cannot be the source of a number");
  if (!SECTION_RE.test(p.statute))
    return fail(at, "set_retention: statute must name the act and a section (e.g. ss. 34, 35.3 or art. 23)");
  return null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEYS = new Set(["recipe_id", "schema_version", "name", "items"]);
const RECOVERY_HINTS = {
  recipe: "Fix the recipe JSON and call execute_mapping_workflow again with the corrected recipe.",
  item: (i) =>
    `Fix item ${i} in the recipe (or drop it if it is not needed) and call execute_mapping_workflow again with the corrected recipe.`,
};

function errorContract(failed_item_index, reason) {
  return {
    ok: false,
    failed_item_index,
    reason,
    partial_state: null,
    recovery_hint: failed_item_index === null ? RECOVERY_HINTS.recipe : RECOVERY_HINTS.item(failed_item_index),
  };
}

function validateRecipe(recipe, known) {
  if (typeof recipe !== "object" || recipe === null || Array.isArray(recipe))
    return errorContract(null, "Recipe must be a JSON object with recipe_id, schema_version, and items.");

  for (const k of Object.keys(recipe))
    if (!TOP_LEVEL_KEYS.has(k))
      return errorContract(null, `Unknown top-level recipe field "${k}". Allowed: recipe_id, schema_version, name, items.`);

  if (typeof recipe.recipe_id !== "string" || !RECIPE_ID_RE.test(recipe.recipe_id))
    return errorContract(null, 'recipe_id must match ^[A-Za-z0-9_-]+$ (1 to 128 characters).');

  if (typeof recipe.schema_version !== "string" || !SCHEMA_VERSION_RE.test(recipe.schema_version))
    return errorContract(
      null,
      `schema_version "${recipe.schema_version}" is not supported. Supported range: 1.0.x.`
    );

  if (recipe.name !== undefined && (typeof recipe.name !== "string" || recipe.name.length > 200))
    return errorContract(null, "name, when present, must be a string of at most 200 characters.");

  if (!Array.isArray(recipe.items) || recipe.items.length < 1)
    return errorContract(null, "items must be a non-empty array of {intent, params}.");

  if (recipe.items.length > MAX_ITEMS)
    return errorContract(
      null,
      `Recipe has ${recipe.items.length} items, above the limit of ${MAX_ITEMS} items. Split the recipe into smaller recipes.`
    );

  for (let i = 0; i < recipe.items.length; i++) {
    const item = recipe.items[i];
    const at = `items[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return errorContract(i, `${at} must be an object with {intent, params}.`);
    if (Object.keys(item).some((k) => k !== "intent" && k !== "params"))
      return errorContract(i, `${at} has unknown fields; only intent and params are allowed.`);
    if (typeof item.intent !== "string")
      return errorContract(i, `${at}.intent must be a string.`);
    if (!known.has(item.intent))
      return errorContract(
        i,
        `${at}: unknown intent "${item.intent}". Known intents: ${[...known].sort().join(", ")}.`
      );
    if (RECOVERY_INTENTS.has(item.intent))
      return errorContract(
        i,
        `${at}: intent "${item.intent}" is an executor-only recovery action; recipes must not reference it. Remove it from the recipe.`
      );
    if (typeof item.params !== "object" || item.params === null || Array.isArray(item.params))
      return errorContract(i, `${at}.params must be an object.`);

    const rule = INTENT_RULES[item.intent];
    for (const req of rule.required)
      if (!(req in item.params))
        return errorContract(i, `${at}: intent "${item.intent}" is missing required param "${req}".`);

    const extra = Object.keys(item.params).filter((k) => !allParamKeys(item.intent).has(k));
    if (extra.length > 0)
      return errorContract(i, `${at}: intent "${item.intent}" does not accept param(s): ${extra.join(", ")}.`);

    const paramsBytes = Buffer.byteLength(JSON.stringify(item.params), "utf8");
    if (paramsBytes > MAX_PARAMS_BYTES)
      return errorContract(
        i,
        `${at}: serialized params are ${paramsBytes} bytes, above the per-item limit of ${MAX_PARAMS_BYTES} bytes.`
      );

    const shapeErr = rule.check(item.params, i);
    if (shapeErr) return errorContract(shapeErr.failed_item_index, shapeErr.reason);
  }

  return null; // valid
}

const paramKeysCache = {};
function allParamKeys(intent) {
  if (!paramKeysCache[intent]) {
    const rule = INTENT_RULES[intent];
    const keys = new Set(rule.required);
    // Optional params per intent (mirrors recipe-schema.json).
    const optional = {
      add_node: [], add_collection_point: [], connect: [], set_field: [],
      set_retention: ["verify_only", "anchor", "range_min_years", "range_max_years", "statute"],
      run_check: [], export: [], confirm_node: ["note"], flag_for_review: ["node_id", "item_index"],
    };
    for (const k of optional[intent] || []) keys.add(k);
    paramKeysCache[intent] = keys;
  }
  return paramKeysCache[intent];
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const sessions = new Map();
const PAGE_DEEP_LINK_BASE = "https://movahedi.ca/tools/data-mapping-guide/";

function openSession(recipe) {
  const seed = recipe.recipe_id + "\0" + Date.now();
  const session_id = "s1-" + crypto.createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 12);
  const session = {
    session_id,
    recipe_id: recipe.recipe_id,
    item_count: recipe.items.length,
    status: "ticketed",
    created_at: new Date().toISOString(),
    results: [],
    listeners: new Set(),
  };
  sessions.set(session_id, session);
  return session;
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

const known = knownIntents();

function toolExecuteMappingWorkflow(params) {
  const recipe = params && params.recipe;
  const err = validateRecipe(recipe, known);
  if (err) return { ok: true, result: err, isError: false };

  const jsonBytes = Buffer.byteLength(JSON.stringify(recipe), "utf8");
  if (jsonBytes > MAX_JSON_BYTES)
    return {
      ok: true,
      result: errorContract(
        null,
        `Serialized recipe is ${jsonBytes} bytes, above the limit of ${MAX_JSON_BYTES} bytes (64KB). Split the recipe into smaller recipes.`
      ),
      isError: false,
    };

  const session = openSession(recipe);
  return {
    ok: true,
    result: {
      ok: true,
      session_id: session.session_id,
      recipe_id: session.recipe_id,
      item_count: session.item_count,
      status: "ticketed",
      deep_link: `${PAGE_DEEP_LINK_BASE}?ticket=${session.session_id}`,
    },
    isError: false,
  };
}

function toolGetSession(params) {
  const id = params && params.session_id;
  if (typeof id !== "string" || id.length === 0)
    return { ok: false, code: -32602, message: "get_session: session_id is required and must be a non-empty string." };
  const s = sessions.get(id);
  if (!s)
    return { ok: false, code: -32002, message: `get_session: unknown session_id "${id}".` };
  return {
    ok: true,
    result: {
      session_id: s.session_id,
      recipe_id: s.recipe_id,
      item_count: s.item_count,
      status: s.status,
      created_at: s.created_at,
      results: s.results,
    },
    isError: false,
  };
}

function toolCancelSession(params) {
  const id = params && params.session_id;
  if (typeof id !== "string" || id.length === 0)
    return { ok: false, code: -32602, message: "cancel_session: session_id is required and must be a non-empty string." };
  const s = sessions.get(id);
  if (!s)
    return { ok: false, code: -32002, message: `cancel_session: unknown session_id "${id}".` };
  if (s.status === "cancelled")
    return { ok: false, code: -32002, message: `cancel_session: session "${id}" is already cancelled.` };
  if (s.status === "finished")
    return { ok: false, code: -32002, message: `cancel_session: session "${id}" is already finished and cannot be cancelled.` };
  s.status = "cancelled";
  return { ok: true, result: { session_id: s.session_id, status: "cancelled" }, isError: false };
}

const TOOLS = [
  {
    name: "execute_mapping_workflow",
    description:
      "Validate a data-mapping recipe against the recipe schema and the action catalogue, then return a session ticket. The in-page executor runs the ticketed session; this tool never executes the recipe itself.",
    inputSchema: {
      type: "object",
      properties: { recipe: { type: "object", description: "Recipe JSON: {recipe_id, schema_version, items[]}" } },
      required: ["recipe"],
      additionalProperties: false,
    },
  },
  {
    name: "get_session",
    description: "Return a ticketed session: session id, recipe id, item count, status, and streamed step results.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_session",
    description: "Cancel a ticketed session. Cancelling an unknown or finished session is a clean error, not a crash.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
];

function handleToolsCall(args) {
  const name = args && args.name;
  const params = (args && args.arguments) || {};
  if (name === "execute_mapping_workflow") return toolExecuteMappingWorkflow(params);
  if (name === "get_session") return toolGetSession(params);
  if (name === "cancel_session") return toolCancelSession(params);
  return { ok: false, code: -32602, message: `Unknown tool "${name}". Available: execute_mapping_workflow, get_session, cancel_session.` };
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over stdio
// ---------------------------------------------------------------------------

function rpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } });
}
function rpcResult(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function handleMessage(msg) {
  if (typeof msg !== "object" || msg === null || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    if (msg && msg.id !== undefined) return rpcError(msg.id, -32600, "Invalid JSON-RPC 2.0 request.");
    return null;
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined;

  try {
    switch (method) {
      case "initialize": {
        const requested = params && params.protocolVersion;
        const version = MCP_VERSIONS.includes(requested) ? requested : MCP_VERSIONS[0];
        return rpcResult(id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: "ai-data-map-mcp", version: TOOL_VERSION },
        });
      }
      case "notifications/initialized":
        return null;
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });
      case "tools/call": {
        const out = handleToolsCall(params);
        if (!out.ok) return rpcError(id, out.code, out.message);
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(out.result, null, 2) }],
          isError: !!out.isError,
        });
      }
      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (isNotification) return null;
    return rpcError(id, -32603, `Internal error: ${e && e.message ? e.message : String(e)}`);
  }
}

function main() {
  // Optional in-process HTTP bridge sharing this server's session store.
  // Set AI_DATA_MAP_BRIDGE_PORT to enable; step events the page POSTs then
  // appear in get_session results. Binds 127.0.0.1 only.
  const bridgePort = Number(process.env.AI_DATA_MAP_BRIDGE_PORT || 0);
  if (bridgePort > 0) {
    const { createBridge } = require("./http-bridge.js");
    createBridge(sessions).listen(bridgePort, "127.0.0.1", () => {
      process.stderr.write(`ai-data-map bridge listening on 127.0.0.1:${bridgePort}\n`);
    });
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(rpcError(null, -32700, "Parse error: expected one JSON object per line.") + "\n");
        continue;
      }
      const reply = handleMessage(msg);
      if (reply !== null) process.stdout.write(reply + "\n");
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

if (require.main === module) main();

module.exports = { validateRecipe, errorContract, knownIntents };
