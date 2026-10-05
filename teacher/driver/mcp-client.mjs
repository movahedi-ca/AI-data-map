#!/usr/bin/env node
/* driver/mcp-client.mjs - stdio JSON-RPC client for the localhost-qa MCP server.
 *
 * Spawns ~/workspace/skills/localhost-qa/src/server.js with CHROME_NO_SANDBOX=1
 * and exposes the tools/call surface as callTool/evalJson/evalRaw. Same wire
 * pattern as the Phase 1 qa-accept.mjs acceptance driver: newline-delimited
 * JSON-RPC over the child stdio, responses matched by id.
 */

import { spawn } from "node:child_process";
import path from "node:path";

const SERVER = path.resolve(
  process.env.HOME + "/workspace/skills/localhost-qa/src/server.js"
);

function makeClient() {
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
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
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
    if (res.error) {
      throw new Error("tool " + name + " failed: " + JSON.stringify(res.error));
    }
    const c = (res.result && res.result.content) || [];
    return c.map((x) => x.text || "").join("\n");
  }

  // The evaluate tool JSON-serializes the script's return value, so a script
  // that returns a JSON string comes back double-encoded.
  async function evalJson(script) {
    const text = await callTool("evaluate", { script });
    return JSON.parse(JSON.parse(text));
  }

  async function evalRaw(script) {
    return await callTool("evaluate", { script });
  }

  async function close() {
    try {
      await callTool("close", {});
    } catch {
      // The browser may already be gone; killing the child is the real close.
    }
    child.kill();
  }

  return { send, notify, callTool, evalJson, evalRaw, close };
}

/* Handshake the MCP session and return the client:
 * { send, notify, callTool(name, args), evalJson(script), evalRaw(script), close() } */
export async function start() {
  const client = makeClient();
  await client.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "teacher-driver", version: "1" },
  });
  client.notify("notifications/initialized", {});
  return client;
}
