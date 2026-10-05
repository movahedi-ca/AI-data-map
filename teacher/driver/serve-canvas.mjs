#!/usr/bin/env node
/* driver/serve-canvas.mjs - serve a disposable copy of the repo web/ dir for
 * the canvas teacher scenarios.
 *
 * Copies <repo>/web into a fresh temp dir (the working tree is never moved
 * or modified) and serves it with `python3 -m http.server` bound to
 * 127.0.0.1 on a fixed port. The copied demo.html is patched so the canvas
 * api returned by window.DMCanvas.init is captured as window.__cvApi: the
 * demo page itself discards the return value, and the scenarios need
 * getView()/setView()/fitView() alongside window.DMImport.applyState.
 *
 * start() resolves to { base, dir, stop() } once the server answers HTTP.
 * stop() kills the server and removes the temp dir.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..", "..");
const WEB_SRC = path.join(REPO_ROOT, "web");
const PORT = 8138;
const INIT_NEEDLE = "window.DMCanvas.init({";
const INIT_PATCH = "window.__cvApi = window.DMCanvas.init({";

function waitForHttp(url, tries) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => {
      n += 1;
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 400) resolve();
        else if (n >= tries) reject(new Error("server did not answer: " + url));
        else setTimeout(tick, 200);
      });
      req.on("error", () => {
        if (n >= tries) reject(new Error("server did not answer: " + url));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

export async function start() {
  if (!fs.existsSync(WEB_SRC)) {
    throw new Error("canvas web source missing: " + WEB_SRC);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teacher-canvas-"));
  fs.cpSync(WEB_SRC, dir, { recursive: true });
  const demoPath = path.join(dir, "canvas", "demo.html");
  const html = fs.readFileSync(demoPath, "utf8");
  if (html.indexOf(INIT_NEEDLE) === -1) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error("demo.html no longer calls window.DMCanvas.init directly; update the __cvApi patch");
  }
  fs.writeFileSync(demoPath, html.replace(INIT_NEEDLE, INIT_PATCH), "utf8");
  const child = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
    cwd: dir,
    stdio: "ignore",
  });
  const base = "http://127.0.0.1:" + PORT;
  try {
    await waitForHttp(base + "/canvas/demo.html", 50);
  } catch (e) {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return {
    base,
    dir,
    stop() {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
