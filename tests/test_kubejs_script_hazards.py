#!/usr/bin/env python3
"""KubeJS server scripts must avoid two Rhino footguns that fail SILENTLY.

Both were found on 2026-09-28 by loading a script on a running server, not by
reading it, and neither produces an error anyone would notice.

1. `const` / `let` INSIDE A `try` BLOCK.
   This build's Rhino (kubejs-forge-2001.6.5, rhino-forge-2001.2.3) throws
   "redeclaration of var <name>" on the FIRST call, not just on repeat calls.
   The entire try block is therefore dead and the catch always wins. Because
   try/catch in these scripts exists precisely to provide a fallback, the script
   keeps running and looks correct: hub.js read its whole config file into
   default values, and reported "minecraft:overworld" for every dimension,
   without logging a thing. Use `var` inside try blocks.

   Proven on the live server with this, which failed on call 1, 2 and 3:

       function constInTry(n) {
           try { const v = n * 2; return v }
           catch (e) { return 'THREW: ' + e }
       }

2. TOP-LEVEL NAMES COLLIDING BETWEEN SCRIPTS.
   Every server script shares ONE global scope. A top-level `const CONFIG` in
   one file collides with the same name in another and kills the second script
   outright with "redeclaration of var CONFIG" - that is how an early draft of
   hub.js silently disabled playtime_limit.js, and with it the daily playtime
   cap. Two scripts loaded fine, two did not, and the only clue was the count in
   "Loaded 2/4 KubeJS server scripts".

   Having top-level names is fine and the existing scripts do it; only REUSING
   one across files breaks. The cheapest way to be immune is an IIFE, which is
   what hub.js does, but this test only fails on an actual collision.

This is a tripwire, not a style rule. Both checks encode a specific failure that
already happened once and cost a debugging session each.
"""

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT_DIRS = [
    REPO / "data" / "kubejs" / "server_scripts",
    REPO / "data" / "kubejs" / "startup_scripts",
]

DECL = re.compile(r"\b(const|let)\s+([A-Za-z_$][\w$]*)")


def strip_noise(line: str) -> str:
    """Drop line comments and string literals so they cannot trigger a match."""
    line = re.sub(r"//.*$", "", line)
    line = re.sub(r"'(?:[^'\\]|\\.)*'", "''", line)
    line = re.sub(r'"(?:[^"\\]|\\.)*"', '""', line)
    return line


def find_const_in_try(path: Path):
    """Return [(lineno, name)] for const/let declared inside a try block."""
    findings = []
    depth = None          # brace depth at which the current try block opened
    curr = 0
    in_block_comment = False

    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw
        if in_block_comment:
            if "*/" in line:
                line = line.split("*/", 1)[1]
                in_block_comment = False
            else:
                continue
        if "/*" in line:
            before, _, after = line.partition("/*")
            if "*/" in after:
                line = before + after.split("*/", 1)[1]
            else:
                line = before
                in_block_comment = True

        line = strip_noise(line)

        opens = line.count("{")
        closes = line.count("}")

        if depth is not None:
            for m in DECL.finditer(line):
                findings.append((lineno, m.group(2), raw.strip()))

        if re.search(r"\btry\s*\{", line) and depth is None:
            depth = curr + line[: line.index("{") + 1].count("{")

        curr += opens - closes

        if depth is not None and curr < depth:
            depth = None

    return findings


TOP_LEVEL = re.compile(r"^(?:const|let|var)\s+([A-Za-z_$][\w$]*)")


def find_global_declarations(path: Path):
    """Return [(lineno, name)] for names declared in the shared global scope.

    A file wrapped in an IIFE indents its body, so a declaration sitting at
    column zero is the one that lands in the scope every script shares.
    """
    findings = []
    for lineno, raw in enumerate(
        path.read_text(encoding="utf-8").splitlines(), 1
    ):
        m = TOP_LEVEL.match(strip_noise(raw))
        if m:
            findings.append((lineno, m.group(1), raw.strip()))
    return findings


def main() -> int:
    scripts = []
    for d in SCRIPT_DIRS:
        if d.is_dir():
            scripts.extend(sorted(d.glob("*.js")))

    if not scripts:
        print("FAIL: no KubeJS scripts found - did the paths move?")
        return 1

    failed = False
    owners: dict[str, list[tuple[str, int]]] = {}

    for path in scripts:
        rel = path.relative_to(REPO)
        if path.name == "example.js":
            continue

        bad_try = find_const_in_try(path)
        if bad_try:
            failed = True
            print(f"FAIL: {rel}: const/let inside a try block")
            print("      Rhino kills the whole block; the catch always wins.")
            for lineno, name, src in bad_try:
                print(f"    line {lineno}: {name!r}  ->  {src}")
                print(f"        use `var {name}` instead")

        for lineno, name, _src in find_global_declarations(path):
            owners.setdefault(name, []).append((str(rel), lineno))

    collisions = {n: w for n, w in owners.items() if len(w) > 1}
    if collisions:
        failed = True
        print("FAIL: the same top-level name is declared by more than one")
        print("      script. They share one scope, so the second to load dies")
        print('      with "redeclaration of var <name>" and stops running.')
        for name, where in sorted(collisions.items()):
            spots = ", ".join(f"{f}:{ln}" for f, ln in where)
            print(f"    {name!r} declared in {spots}")
        print("        wrap one of them in (function () { ... })()")

    if failed:
        print("\nSee this file's docstring for why these fail silently.")
        return 1

    print(f"  checked {len(scripts)} KubeJS scripts")
    print("  PASS: no const/let inside try blocks")
    print(f"  PASS: {len(owners)} top-level names, none shared between scripts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
