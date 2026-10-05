#!/usr/bin/env node
/*
 * submit-indexnow.js: ping api.indexnow.org with the URLs in urls.txt.
 *
 * Usage: node submit-indexnow.js <indexnow-key> [urls-file]
 *   <indexnow-key>  The IndexNow key for the site. Passed as an argument so it
 *                   is never stored in the repo or in any file here.
 *   [urls-file]     Defaults to urls.txt next to this script. One URL per
 *                   line; blank lines and lines starting with # are ignored.
 *
 * Protocol (https://www.indexnow.org/documentation): POST JSON to
 * https://api.indexnow.org/indexnow with { host, key, keyLocation, urlList }.
 * The keyLocation is the public URL where the key file lives, which by
 * convention is https://<host>/<key>.txt on the site itself.
 *
 * Stdlib only: https, fs, path, url. Exit 0 on 200/202, non-zero otherwise.
 */
const https = require("https");
const fs = require("fs");
const path = require("path");

function fail(msg) {
  console.error("submit-indexnow: " + msg);
  process.exit(1);
}

const key = process.argv[2];
if (!key) {
  fail("missing <indexnow-key> argument. Usage: node submit-indexnow.js <indexnow-key> [urls-file]");
}
if (/[^A-Za-z0-9_-]/.test(key)) {
  fail("indexnow key looks invalid (expected letters, digits, dash, underscore only)");
}

const urlsFile = process.argv[3] || path.join(__dirname, "urls.txt");
let urls;
try {
  urls = fs
    .readFileSync(urlsFile, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
} catch (e) {
  fail("cannot read urls file " + urlsFile + ": " + e.message);
}
if (urls.length === 0) {
  fail("no URLs found in " + urlsFile);
}

let host;
try {
  host = new URL(urls[0]).hostname;
} catch (e) {
  fail("first URL is not a valid absolute URL: " + urls[0]);
}
const mixedHosts = urls.some((u) => {
  try {
    return new URL(u).hostname !== host;
  } catch {
    return true;
  }
});
if (mixedHosts) {
  fail("all URLs must live on the same host; found a mix around host " + host);
}

const body = JSON.stringify({
  host,
  key,
  keyLocation: "https://" + host + "/" + key + ".txt",
  urlList: urls,
});

const req = https.request(
  {
    hostname: "api.indexnow.org",
    path: "/indexnow",
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    },
  },
  (res) => {
    let data = "";
    res.on("data", (c) => (data += c));
    res.on("end", () => {
      console.log("submit-indexnow: " + urls.length + " URLs to " + host);
      console.log("submit-indexnow: api.indexnow.org -> HTTP " + res.statusCode);
      if (res.statusCode === 200 || res.statusCode === 202) {
        console.log("submit-indexnow: accepted");
        process.exit(0);
      }
      console.error("submit-indexnow: rejected: " + (data || "(empty body)"));
      process.exit(2);
    });
  }
);
req.on("error", (e) => fail("request failed: " + e.message));
req.end(body);
