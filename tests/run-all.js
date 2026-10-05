#!/usr/bin/env node
/* tests/run-all.js - single-command test runner for the AI-data-map suite.
   Run with: node tests/run-all.js   (from the repo root)
   Discovers every *.test.js under tests/ plus the pre-existing suites that
   live next to their sources, runs each in its own node process, and
   aggregates the results. Exit 0 when everything passes, 1 otherwise.
   No npm dependencies. */
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function walk(dir, out) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    if (name.name === "node_modules" || name.name === ".git") continue;
    const p = path.join(dir, name.name);
    if (name.isDirectory()) {
      if (path.relative(ROOT, p).split(path.sep).includes("vendor")) continue;
      walk(p, out);
    } else if (name.name.endsWith(".test.js")) {
      out.push(p);
    }
  }
  return out;
}

const files = walk(path.join(ROOT, "tests"), []);
for (const f of [
  "web/chatbot/chatbot.test.js",
  "web/canvas/canvas.test.js",
  "web/import/engine/engine.test.js",
  "web/import/worker/parse-core.test.js",
  "mcp/test-contract.js",
]) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) files.push(p);
}
files.sort();

let passFiles = 0;
let failFiles = 0;
let totalAssertions = 0;
const failures = [];

for (const f of files) {
  const rel = path.relative(ROOT, f);
  let out = "";
  let code = 0;
  try {
    out = execFileSync(process.execPath, [f], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 300000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    /* execFileSync throws on non-zero exit AND its stdout/stderr are still
       attached to the error object: fold them back in for diagnosis. */
    code = e.status || 1;
    out = (e.stdout || "") + "\n" + (e.stderr || "");
    if (code !== 0) {
      failFiles++;
      failures.push(rel + " (exit " + code + ")\n" + out.slice(-3000));
      continue;
    }
  }
  /* Assertion counts come in several house styles; exit code is the real
     gate, the count is informational. */
  let n = 0;
  let m =
    out.match(/PASS\s+(\d+)/) ||
    out.match(/(\d+)\s+assertions?\s+passed/i) ||
    out.match(/[ℹi]\s+pass\s+(\d+)/);
  if (m) n = parseInt(m[1], 10);
  if (/ALL GREEN/.test(out) || code === 0) {
    passFiles++;
    totalAssertions += n;
    console.log("ok   " + rel + (n ? " (" + n + " assertions)" : " (suite green)"));
  } else {
    failFiles++;
    failures.push(rel + "\n(no pass signal in output)\n" + out.slice(-2000));
  }
}

console.log("----");
console.log("files: " + files.length + ", passed: " + passFiles + ", failed: " + failFiles);
console.log("total assertions: " + totalAssertions);
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) console.log("==== " + f);
  process.exit(1);
}
console.log("ALL GREEN");
