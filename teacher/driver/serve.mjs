#!/usr/bin/env node
/* driver/serve.mjs - serve a disposable copy of the Phase 1 import demo.
 *
 * Copies hidden_files/phase1/ui/site-demo into a fresh temp dir (the Phase 1
 * working tree is never moved or modified) and serves it with
 * `python3 -m http.server` bound to 127.0.0.1 on a fixed port.
 *
 * start() resolves to { base, dir, stop() } once the server answers HTTP.
 * stop() kills the server and removes the temp dir.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const DEMO_SRC = path.resolve(
  process.env.HOME +
    "/workspace/goals/taiga-style-data-mapping-agent-on-movahedi-ca/hidden_files/phase1/ui/site-demo"
);
const PORT = 8137;

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
  if (!fs.existsSync(DEMO_SRC)) {
    throw new Error("demo source missing: " + DEMO_SRC);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teacher-demo-"));
  fs.cpSync(DEMO_SRC, dir, { recursive: true });
  const child = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
    cwd: dir,
    stdio: "ignore",
  });
  const base = "http://127.0.0.1:" + PORT;
  try {
    await waitForHttp(base + "/index.html", 50);
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
