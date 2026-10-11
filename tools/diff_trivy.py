#!/usr/bin/env python3
"""Diff two Trivy JSON reports and say whether a base-image bump is worth taking.

    python tools/diff_trivy.py before.json after.json
    python tools/diff_trivy.py before.json after.json --json

Exit codes:
    0  the new image is the same or better
    1  the new image INTRODUCES findings that were not there before

Why this exists as a file rather than a line in a workflow: the Dockerfile's
header records a bump that was documented as fixing two micrometer CVEs and did
not, because the claim was never diffed - it was inferred. This makes the diff
the cheap option.

TWO TRAPS, both hit while writing this, both worth stating plainly:

  1. A target with NO findings is OMITTED from Trivy's JSON entirely. Absent is
     not the same as "not scanned". Reading a missing section as "Trivy skipped
     it" nearly got a genuine 8-CVE improvement dismissed as an artefact.

  2. Do not key findings on Target alone. Target embeds the IMAGE NAME for OS
     package results, so the same finding in two differently-tagged images looks
     like one fixed and one introduced. Key on (CVE, package) for the real
     answer, and report per-target counts separately for the alert-count view -
     GitHub code scanning counts per location, so the two numbers legitimately
     differ and both are worth printing.
"""
import argparse
import json
import sys
from collections import Counter


def load(path):
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    by_pkg, by_target = {}, Counter()
    for result in doc.get("Results") or []:
        vulns = result.get("Vulnerabilities") or []
        if not vulns:
            continue
        # OS-package results are targeted by IMAGE NAME ("mc-pin:old (ubuntu
        # 26.04)"), so comparing two differently-tagged images would show the
        # same three findings as one component vanishing and another appearing.
        # Collapse those to a single stable label; other targets are file paths
        # and compare directly once the "(...)" suffix is dropped.
        target = result.get("Target", "").split("(")[0].strip()
        if result.get("Class") == "os-pkgs":
            target = "OS packages"
        by_target[target] += len(vulns)
        for v in vulns:
            key = (v["VulnerabilityID"], v.get("PkgName") or v.get("PkgPath") or "")
            by_pkg[key] = v.get("Severity", "UNKNOWN")
    return by_pkg, by_target


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("before")
    ap.add_argument("after")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    old_pkg, old_tgt = load(args.before)
    new_pkg, new_tgt = load(args.after)

    fixed = sorted(set(old_pkg) - set(new_pkg))
    introduced = sorted(set(new_pkg) - set(old_pkg))
    old_total, new_total = sum(old_tgt.values()), sum(new_tgt.values())

    def sev(counts):
        return dict(Counter(counts.values()))

    report = {
        "total_before": old_total,
        "total_after": new_total,
        "unique_before": len(old_pkg),
        "unique_after": len(new_pkg),
        "fixed": [{"cve": c, "pkg": p, "severity": old_pkg[(c, p)]} for c, p in fixed],
        "introduced": [{"cve": c, "pkg": p, "severity": new_pkg[(c, p)]}
                       for c, p in introduced],
        "severity_before": sev(old_pkg),
        "severity_after": sev(new_pkg),
        "per_target_before": dict(old_tgt),
        "per_target_after": dict(new_tgt),
        "worth_taking": bool(fixed) and not introduced,
    }

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"findings (per location): {old_total} -> {new_total} "
              f"({new_total - old_total:+d})")
        print(f"unique (cve,package):    {len(old_pkg)} -> {len(new_pkg)} "
              f"({len(new_pkg) - len(old_pkg):+d})")
        print(f"severity before: {report['severity_before']}")
        print(f"severity after:  {report['severity_after']}\n")

        print(f"FIXED ({len(fixed)}):")
        for c, p in fixed:
            print(f"    {old_pkg[(c, p)]:8} {c:18} {p}")
        if not fixed:
            print("    (none)")

        print(f"\nINTRODUCED ({len(introduced)}):")
        for c, p in introduced:
            print(f"    {new_pkg[(c, p)]:8} {c:18} {p}")
        if not introduced:
            print("    (none)")

        changed = {t for t in set(old_tgt) | set(new_tgt)
                   if old_tgt.get(t, 0) != new_tgt.get(t, 0)}
        if changed:
            print("\nper-component change:")
            for t in sorted(changed):
                print(f"    {t:30} {old_tgt.get(t, 0):3} -> {new_tgt.get(t, 0):3}")

        print("\nverdict: " + (
            "WORTH TAKING - fixes findings, introduces none" if report["worth_taking"]
            else "INTRODUCES NEW FINDINGS - do not take as-is" if introduced
            else "no change - leave the pin alone"))

    return 1 if introduced else 0


if __name__ == "__main__":
    sys.exit(main())
