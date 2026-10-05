#!/usr/bin/env python3
"""
Layer 3: tree-sitter code graph scan for the AI-data-map repo.

Queries (each becomes a rule id in the findings):
  dead-function    - function declarations / const arrow functions never called
                     anywhere in first-party code and not exported
  wrapper-function - function whose body is a single return/call that only
                     delegates to another function (low/info slop signal)
  unused-export    - exported names never imported or required anywhere in
                     first-party code
  todo-inventory   - TODO / FIXME / XXX / HACK comments with file and line
  duplicate-block  - identical normalized function bodies (min 6 non-trivial
                     lines) appearing more than once across first-party files

Scope: first-party JS (.js, .mjs) under web/, mcp/, tools/, tests/, training/,
teacher/, excluding vendor/ and node_modules/.

All name-resolution here is global-and-heuristic (a per-repo approximation,
not a true scope-aware dataflow analysis). Findings are signals for the weekly
fix cycle, not verdicts. See scanning/layer3/README.md.

Env:
  SCAN_ROOT      - repo root (default: two levels above this script)
  SCAN_OUT_PATH  - where to write the JSON report (default:
                   <root>/scanning/reports/layer3-latest.json)

Exit codes: 0 clean, 2 findings present, 1 tool error.
"""

import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

try:
    from tree_sitter import Language, Parser
    import tree_sitter_javascript

    PARSER = "tree-sitter"
except ImportError:  # pragma: no cover - documented fallback, not expected
    PARSER = "fallback"
    Language = Parser = None

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("SCAN_ROOT") or os.path.abspath(
    os.path.join(SCRIPT_DIR, "..", "..")
)
OUT_PATH = os.environ.get("SCAN_OUT_PATH") or os.path.join(
    ROOT, "scanning", "reports", "layer3-latest.json"
)

SCOPE_DIRS = ("web", "mcp", "tools", "tests", "training", "teacher")
EXTS = (".js", ".mjs")
EXCLUDED_PARTS = {"vendor", "node_modules"}
TODO_RE = re.compile(r"\b(TODO|FIXME|XXX|HACK)\b")

SEVERITY = {
    "dead-function": "medium",
    "wrapper-function": "low",
    "unused-export": "low",
    "todo-inventory": "info",
    "duplicate-block": "low",
}

TRIVIAL_LINE_RE = re.compile(r"^[{}\(\);,\[\]]+$")


def first_party_files(root):
    files = []
    for sub in SCOPE_DIRS:
        base = os.path.join(root, sub)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDED_PARTS]
            rel_dir = os.path.relpath(dirpath, root)
            parts = set(rel_dir.split(os.sep))
            if parts & EXCLUDED_PARTS:
                continue
            for fn in sorted(filenames):
                if fn.endswith(EXTS):
                    files.append(os.path.join(dirpath, fn))
    return files


def parse(path):
    with open(path, "rb") as fh:
        src = fh.read()
    if PARSER != "tree-sitter":
        return None, src
    lang = Language(tree_sitter_javascript.language())
    parser = Parser(lang)
    return parser.parse(src), src


def text(node):
    return node.text.decode("utf-8", "replace")


def line_of(node):
    return node.start_point[0] + 1


def walk(node):
    yield node
    for child in node.children:
        yield from walk(child)


def is_def_name_site(node):
    """True if this identifier node is a definition site (name being declared)."""
    parent = node.parent
    if parent is None:
        return False
    if parent.type == "function_declaration" and parent.child_by_field_name("name") is node:
        return True
    if parent.type == "variable_declarator" and parent.child_by_field_name("name") is node:
        return True
    if parent.type in ("formal_parameters", "catch_clause"):
        return True
    return False


class RepoGraph:
    def __init__(self):
        # name -> list of {"file", "line", "exported", "wrapper"}
        self.defs = {}
        self.used_names = set()   # identifiers referenced anywhere
        self.used_props = set()   # property names used via member access
        # exporting file relpath -> {name: {"file", "line", "kind"}}
        self.exports = {}
        # list of (relpath, target_file_relpath, names:set|None, wholesale:bool)
        self.import_edges = []
        self.dup_groups = {}      # body hash -> list of {"file","line","name"}
        self.string_literals = set()  # every string literal, for dynamic imports
        self.findings = []
        self.todo_findings = []

    def add_def(self, name, rel, line):
        self.defs.setdefault(name, []).append(
            {"file": rel, "line": line, "exported": False}
        )

    def mark_exported_def(self, name, rel):
        for d in self.defs.get(name, []):
            if d["file"] == rel:
                d["exported"] = True


def callee_of(call_node):
    fn = call_node.child_by_field_name("function")
    if fn is None:
        return None
    if fn.type == "identifier":
        return text(fn)
    if fn.type == "member_expression":
        prop = fn.child_by_field_name("property")
        if prop is not None:
            obj = fn.child_by_field_name("object")
            base = text(obj).split("\n")[0][:24] if obj is not None else ""
            return base + "." + text(prop)
    return None


def single_call_body(body_node):
    """If body is a single call (direct or returned), return the callee name."""
    if body_node is None:
        return None
    if body_node.type == "call_expression":
        return callee_of(body_node)
    if body_node.type == "statement_block":
        stmts = [c for c in body_node.children if c.is_named]
        if len(stmts) != 1:
            return None
        stmt = stmts[0]
        if stmt.type == "return_statement":
            val = stmt.child_by_field_name("value")
            if val is not None and val.type == "call_expression":
                return callee_of(val)
        elif stmt.type == "expression_statement":
            expr = stmt.child_by_field_name("expression")
            if expr is not None and expr.type == "call_expression":
                return callee_of(expr)
    return None


def body_lines_for_dup(body_node, src_text):
    """Non-trivial source lines of a function body, comments stripped."""
    comment_ranges = set()
    for n in walk(body_node):
        if n.type == "comment":
            for r in range(n.start_point[0], n.end_point[0] + 1):
                comment_ranges.add(r)
    src_lines = src_text.split("\n")
    lines = []
    for i in range(body_node.start_point[0], body_node.end_point[0] + 1):
        if i in comment_ranges or i >= len(src_lines):
            continue
        s = src_lines[i].strip()
        if not s or TRIVIAL_LINE_RE.match(s):
            continue
        lines.append(s)
    return lines


def export_names_from_export_statement(stmt):
    """Names an export_statement introduces. Only direct children count:
    nested declarations inside an exported function body are not exports."""
    found = {}
    for child in stmt.children:
        if not child.is_named:
            continue
        if child.type == "function_declaration":
            name = child.child_by_field_name("name")
            if name is not None:
                found.setdefault(text(name), line_of(child))
        elif child.type in ("lexical_declaration", "variable_declaration"):
            for decl in child.children:
                if decl.type != "variable_declarator":
                    continue
                name = decl.child_by_field_name("name")
                if name is not None and name.type == "identifier":
                    found.setdefault(text(name), line_of(decl))
        elif child.type == "export_clause":
            for spec in child.children:
                if spec.type != "export_specifier":
                    continue
                ids = [c for c in spec.children if c.type == "identifier"]
                if ids:
                    # export { a, b as c }: the pre-as name is the export
                    # importers see; the local binding is ids[0] unless aliased.
                    found.setdefault(text(ids[0]), line_of(spec))
    return found


def analyze_file(tree, src_text, rel, graph):
    src_str = src_text.decode("utf-8", "replace")
    defs_here = []

    def handle_function(name, node, body_node):
        ln = line_of(node if node.type != "variable_declarator" else node)
        graph.add_def(name, rel, ln)
        defs_here.append((name, node, body_node))

    for node in walk(tree.root_node):
        t = node.type
        if t == "function_declaration":
            name = node.child_by_field_name("name")
            if name is not None:
                body = node.child_by_field_name("body")
                handle_function(text(name), node, body)
        elif t == "variable_declarator":
            name = node.child_by_field_name("name")
            val = node.child_by_field_name("value")
            if (
                name is not None
                and name.type == "identifier"
                and val is not None
                and val.type in ("arrow_function", "function_expression", "function")
            ):
                body = val.child_by_field_name("body")
                handle_function(text(name), node, body)
        elif t == "comment":
            if TODO_RE.search(text(node)):
                msg = " ".join(text(node).split())[:100]
                graph.todo_findings.append(
                    {
                        "rule": "todo-inventory",
                        "severity": SEVERITY["todo-inventory"],
                        "file": rel,
                        "line": line_of(node),
                        "message": "Marker found: " + msg,
                    }
                )
        elif t == "string":
            # dynamic import("./x.mjs") / pathToFileURL(join(dir, "x.mjs"))
            # cannot be resolved statically; the basename heuristic in the
            # unused-export stage treats a matching basename in any string
            # literal as a use of that module's exports.
            graph.string_literals.add(text(node).strip("\"'"))
        elif t == "identifier":
            if not is_def_name_site(node):
                graph.used_names.add(text(node))
        elif t == "shorthand_property_identifier":
            graph.used_names.add(text(node))
        elif t == "member_expression":
            prop = node.child_by_field_name("property")
            if prop is not None and prop.type in ("property_identifier", "identifier"):
                graph.used_props.add(text(prop))
        elif t == "call_expression":
            callee = callee_of(node)
            if callee:
                graph.used_names.add(callee.split(".")[-1])
                graph.used_props.add(callee.split(".")[-1])

    # wrapper-function + duplicate-block need the def pass complete
    for name, node, body in defs_here:
        callee = single_call_body(body)
        if callee and callee.split(".")[-1] != name:
            graph.findings.append(
                {
                    "rule": "wrapper-function",
                    "severity": SEVERITY["wrapper-function"],
                    "file": rel,
                    "line": line_of(node),
                    "message": "Function '%s' only delegates to '%s' "
                    "with no added logic." % (name, callee),
                }
            )
        if body is not None and body.type == "statement_block":
            lines = body_lines_for_dup(body, src_str)
            if len(lines) >= 6:
                key = hashlib.sha256(
                    re.sub(r"\s+", "", "\n".join(lines)).encode("utf-8")
                ).hexdigest()
                graph.dup_groups.setdefault(key, []).append(
                    {"file": rel, "line": line_of(node), "name": name,
                     "nlines": len(lines)}
                )

    # exports: ES module
    for node in walk(tree.root_node):
        if node.type != "export_statement":
            continue
        for name, ln in export_names_from_export_statement(node).items():
            graph.exports.setdefault(rel, {})[name] = {
                "file": rel, "line": ln, "kind": "es"
            }
            graph.mark_exported_def(name, rel)
            graph.used_names.add(name)

    # exports: CommonJS + import/require edges
    for node in walk(tree.root_node):
        if node.type == "assignment_expression":
            left = node.child_by_field_name("left")
            right = node.child_by_field_name("right")
            if left is not None and left.type == "member_expression":
                obj = left.child_by_field_name("object")
                prop = left.child_by_field_name("property")
                if obj is None or prop is None:
                    continue
                obj_t, prop_t = text(obj), text(prop)
                is_exports_root = (
                    obj_t == "module.exports" or obj_t == "exports"
                ) or (obj_t == "module" and prop_t == "exports")
                if is_exports_root and not (
                    obj_t == "module" and prop_t == "exports"
                ):
                    # exports.foo = ... / module.exports.foo = ...
                    graph.exports.setdefault(rel, {})[prop_t] = {
                        "file": rel, "line": line_of(node), "kind": "cjs"
                    }
                    graph.mark_exported_def(prop_t, rel)
                if obj_t == "module" and prop_t == "exports":
                    # module.exports = <something>
                    if right is not None:
                        if right.type == "object":
                            for pair in right.children:
                                if pair.type not in ("pair", "shorthand_property_identifier"):
                                    continue
                                key = pair.child_by_field_name("key")
                                kname = (
                                    text(key).strip("\"'") if key is not None
                                    else text(pair)
                                )
                                graph.exports.setdefault(rel, {})[kname] = {
                                    "file": rel, "line": line_of(node), "kind": "cjs"
                                }
                                graph.mark_exported_def(kname, rel)
                        elif right.type == "identifier":
                            nm = text(right)
                            graph.exports.setdefault(rel, {})[nm] = {
                                "file": rel, "line": line_of(node), "kind": "cjs"
                            }
                            graph.mark_exported_def(nm, rel)
                            graph.used_names.add(nm)
        elif node.type == "import_statement":
            source = node.child_by_field_name("source")
            src_path = (
                text(source).strip("\"'") if source is not None else None
            )
            names = set()
            for spec in walk(node):
                if spec.type == "import_specifier":
                    ids = [c for c in spec.children if c.type == "identifier"]
                    if ids:
                        names.add(text(ids[0]))
                        graph.used_names.add(text(ids[0]))
                elif spec.type == "namespace_import":
                    names.add("*")
            if src_path:
                graph.import_edges.append((rel, src_path, names, False))
        elif node.type == "call_expression":
            fn = node.child_by_field_name("function")
            args = node.child_by_field_name("arguments")
            if (
                fn is not None and fn.type == "identifier" and text(fn) == "require"
                and args is not None
            ):
                str_args = [
                    c for c in args.children
                    if c.type == "string"
                ]
                if str_args:
                    src_path = text(str_args[0]).strip("\"'")
                    # what shape is the require bound to?
                    parent = node.parent
                    names = None
                    wholesale = True
                    while parent is not None and parent.type not in (
                        "variable_declarator", "assignment_expression",
                        "expression_statement", "program",
                    ):
                        parent = parent.parent
                    if parent is not None and parent.type == "variable_declarator":
                        dname = parent.child_by_field_name("name")
                        if dname is not None and dname.type == "object_pattern":
                            names = set()
                            wholesale = False
                            for p in walk(dname):
                                if p.type == "shorthand_property_identifier":
                                    names.add(text(p))
                                    graph.used_names.add(text(p))
                                elif p.type == "pair":
                                    key = p.child_by_field_name("key")
                                    if key is not None:
                                        names.add(text(key).strip("\"'"))
                    graph.import_edges.append((rel, src_path, names, wholesale))


def resolve_import(from_rel, src_path, file_set):
    """Resolve a relative import/require to a repo-root-relative scanned file."""
    if not src_path.startswith("."):
        return None
    base = os.path.normpath(os.path.join(os.path.dirname(from_rel), src_path))
    for cand in (base, base + ".js", base + ".mjs",
                 os.path.join(base, "index.js")):
        if cand in file_set:
            return cand
    return None


def run():
    graph = RepoGraph()

    files = first_party_files(ROOT)
    rels = [os.path.relpath(f, ROOT) for f in files]
    file_set = set(rels)
    n_functions = 0

    for path, rel in zip(files, rels):
        try:
            tree, src = parse(path)
        except Exception as exc:  # noqa: BLE001 - keep scanning other files
            graph.findings.append(
                {
                    "rule": "parse-error",
                    "severity": "info",
                    "file": rel,
                    "line": 1,
                    "message": "Could not parse file: %s" % exc,
                }
            )
            continue
        if tree is None:
            continue
        analyze_file(tree, src, rel, graph)

    n_functions = sum(len(v) for v in graph.defs.values())
    findings = graph.findings + graph.todo_findings

    # dead-function
    for name, defs in graph.defs.items():
        if name in graph.used_names or name in graph.used_props:
            continue
        for d in defs:
            if d["exported"]:
                continue
            findings.append(
                {
                    "rule": "dead-function",
                    "severity": SEVERITY["dead-function"],
                    "file": d["file"],
                    "line": d["line"],
                    "message": "Function '%s' is never called in "
                    "first-party code and is not exported." % name,
                }
            )

    # unused-export
    for rel, exps in graph.exports.items():
        basename = os.path.basename(rel)
        dynamic_hit = any(
            basename in lit for lit in graph.string_literals
        )
        edges = [
            (names, wholesale)
            for (frm, srcp, names, wholesale) in graph.import_edges
            if resolve_import(frm, srcp, file_set) == rel
        ]
        for name, meta in exps.items():
            used = dynamic_hit
            if name in graph.used_props:
                used = True  # e.g. const s = require('./server'); s.name()
            for names, wholesale in edges:
                if wholesale or (names and (name in names or "*" in names)):
                    used = True
                    break
            if not used:
                findings.append(
                    {
                        "rule": "unused-export",
                        "severity": SEVERITY["unused-export"],
                        "file": meta["file"],
                        "line": meta["line"],
                        "message": "Exported name '%s' is never imported or "
                        "required by first-party code." % name,
                    }
                )

    # duplicate-block (one finding per repeated body)
    for _key, group in graph.dup_groups.items():
        locs = {(g["file"], g["line"], g["name"]) for g in group}
        if len(locs) < 2:
            continue
        locs = sorted(locs)
        first = locs[0]
        others = "; ".join(
            "%s:%d (%s)" % (f, ln, nm) for f, ln, nm in locs[1:6]
        )
        if len(locs) > 6:
            others += "; +%d more" % (len(locs) - 6)
        findings.append(
            {
                "rule": "duplicate-block",
                "severity": SEVERITY["duplicate-block"],
                "file": first[0],
                "line": first[1],
                "message": "Identical %d-line function body also appears in: %s"
                % (group[0]["nlines"], others),
            }
        )

    findings.sort(key=lambda f: (f["rule"], f["file"], f["line"]))

    report = {
        "layer": 3,
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "parser": PARSER,
        "stats": {"files": len(files), "functions": n_functions},
        "findings": findings,
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
        fh.write("\n")

    by_rule = {}
    for f in findings:
        by_rule[f["rule"]] = by_rule.get(f["rule"], 0) + 1
    print("Layer 3 code graph scan (%s parser)" % PARSER)
    print("files scanned: %d, functions: %d" % (len(files), n_functions))
    if by_rule:
        print("findings by rule:")
        for rule in sorted(by_rule):
            print("  %s: %d" % (rule, by_rule[rule]))
        print("total findings: %d" % len(findings))
    else:
        print("no findings")
    print("report: %s" % OUT_PATH)

    return 2 if findings else 0


if __name__ == "__main__":
    try:
        sys.exit(run())
    except Exception as exc:  # noqa: BLE001 - exit code 1 on tool error
        print("layer3 tool error: %s" % exc, file=sys.stderr)
        sys.exit(1)
