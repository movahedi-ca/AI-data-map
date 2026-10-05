#!/usr/bin/env node
"use strict";
/*
 * AI-data-map Phase 7 HTTP bridge (optional companion to the stdio server).
 *
 * Receives step events streamed by the in-page executor and re-broadcasts
 * them over Server-Sent Events for MCP clients that prefer HTTP.
 *
 *   POST /sessions/:id/steps   ingest one step event from the page
 *   GET  /sessions/:id         session record with all streamed results
 *   GET  /sessions/:id/stream  SSE feed of step events
 *
 * Node standard library only. The page integration is NOT wired into the
 * demo pages by default; see mcp/PAGE-BRIDGE.md. The page only posts when
 * the operator sets a localStorage ingest URL, so the default tool page
 * keeps zero external requests.
 *
 * Deployment: run standalone (its own in-memory store), or let the stdio
 * server mount it in-process with a shared session store by setting
 * AI_DATA_MAP_BRIDGE_PORT when starting server.js. In the shared mode,
 * get_session on the stdio server returns the step events the page POSTed.
 */

const http = require("http");

const PORT = Number(process.env.AI_DATA_MAP_BRIDGE_PORT || 8787);
const MAX_BODY_BYTES = 256 * 1024;

function getOrCreateSession(sessions, id) {
  let s = sessions.get(id);
  if (!s) {
    // The page can stream standalone with only the bridge URL configured;
    // such sessions carry no MCP ticket metadata and start as "running".
    s = { session_id: id, recipe_id: null, item_count: null, status: "running", results: [], listeners: new Set() };
    sessions.set(id, s);
  }
  return s;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function validStepEvent(e) {
  if (typeof e !== "object" || e === null) return "body must be a JSON object";
  if (typeof e.action !== "string" || e.action.length === 0) return '"action" must be a non-empty string';
  for (const k of ["narration_en", "narration_fr"]) {
    if (e[k] !== undefined && typeof e[k] !== "string") return `"${k}" must be a string when present`;
  }
  if (e.done_heads !== undefined && (typeof e.done_heads !== "object" || e.done_heads === null || Array.isArray(e.done_heads)))
    return '"done_heads" must be an object when present';
  if (e.terminal !== undefined && typeof e.terminal !== "boolean") return '"terminal" must be a boolean when present';
  return null;
}

function broadcast(s, event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of s.listeners) {
    try { res.write(payload); } catch { /* listener gone; cleaned on close */ }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sessionRecord(s) {
  const { listeners, ...record } = s;
  return record;
}

function createBridge(sessions) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const m = url.pathname.match(/^\/sessions\/([^/]+)(\/steps|\/stream)?$/);
    if (!m) return json(res, 404, { ok: false, error: "not found" });
    const sessionId = decodeURIComponent(m[1]);
    const suffix = m[2] || "";

    if (req.method === "POST" && suffix === "/steps") {
      let body;
      try { body = await readBody(req); } catch (e) { return json(res, 413, { ok: false, error: String(e.message || e) }); }
      let event;
      try { event = JSON.parse(body); } catch { return json(res, 400, { ok: false, error: "body must be valid JSON" }); }
      const bad = validStepEvent(event);
      if (bad) return json(res, 400, { ok: false, error: bad });

      const s = getOrCreateSession(sessions, sessionId);
      const stored = {
        action: event.action,
        narration_en: event.narration_en || "",
        narration_fr: event.narration_fr || "",
        done_heads: event.done_heads || {},
        terminal: event.terminal === true,
        at: new Date().toISOString(),
      };
      s.results.push(stored);
      if (stored.terminal && s.status !== "finished") s.status = "finished";
      broadcast(s, stored);
      return json(res, 200, { ok: true, stored: s.results.length });
    }

    if (req.method === "GET" && suffix === "") {
      const s = sessions.get(sessionId);
      if (!s) return json(res, 404, { ok: false, error: `unknown session "${sessionId}"` });
      return json(res, 200, sessionRecord(s));
    }

    if (req.method === "GET" && suffix === "/stream") {
      const s = getOrCreateSession(sessions, sessionId);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ session_id: sessionId, results: s.results.length })}\n\n`);
      s.listeners.add(res);
      req.on("close", () => s.listeners.delete(res));
      return;
    }

    return json(res, 405, { ok: false, error: "method not allowed" });
  });
}

if (require.main === module) {
  const sessions = new Map();
  createBridge(sessions).listen(PORT, "127.0.0.1", () => {
    process.stderr.write(`ai-data-map bridge listening on 127.0.0.1:${PORT}\n`);
  });
}

module.exports = { createBridge, sessionRecord };
