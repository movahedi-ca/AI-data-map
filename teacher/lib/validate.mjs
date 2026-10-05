// validate.mjs
// Schema validation for snapshots and recipes. Implemented by shelling
// out to python3 + jsonschema (installed, offline); both schemas are
// draft 2020-12 with internal $refs, which jsonschema resolves.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VALIDATOR = `
import json, sys
from jsonschema import Draft202012Validator
schema = json.load(open(sys.argv[1], encoding="utf-8"))
obj = json.load(open(sys.argv[2], encoding="utf-8"))
errors = sorted(Draft202012Validator(schema).iter_errors(obj),
                key=lambda e: list(e.absolute_path))
out = [{"path": "/".join(str(p) for p in e.absolute_path), "message": e.message}
       for e in errors]
print(json.dumps({"ok": not out, "errors": out}))
`;

function runValidator(schemaFile, obj, specsDir) {
  const dir = mkdtempSync(join(tmpdir(), "phase4-validate-"));
  try {
    const objFile = join(dir, "obj.json");
    writeFileSync(objFile, JSON.stringify(obj), "utf8");
    const raw = execFileSync("python3", ["-c", VALIDATOR, join(specsDir, schemaFile), objFile],
      { encoding: "utf8", timeout: 30000 });
    return JSON.parse(raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Returns {ok: boolean, errors: [{path, message}]}.
export function validateSnapshot(obj, specsDir) {
  try {
    return runValidator("state-snapshot-schema.json", obj, specsDir);
  } catch (e) {
    return { ok: false, errors: [{ path: "", message: "validator crashed: " + e.message }] };
  }
}

// Returns {ok: boolean, errors: [{path, message}]}.
export function validateRecipe(obj, specsDir) {
  try {
    return runValidator("recipe-schema.json", obj, specsDir);
  } catch (e) {
    return { ok: false, errors: [{ path: "", message: "validator crashed: " + e.message }] };
  }
}
