#!/usr/bin/env python3
"""Inventory SPDX licenses for every package in Cargo.lock / package-lock.json trees.

Exit codes:
  0 — no forbidden linked licenses (review items may be warned)
  1 — forbidden license found or tool failure
  2 — usage / environment error

Not legal advice. Policy: scripts/supply-chain/license-policy.json
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
POLICY_PATH = Path(__file__).resolve().parent / "license-policy.json"
DEFAULT_OUT = ROOT / "reports" / "license-inventory.json"


def rel(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(ROOT)).replace("\\", "/")
    except ValueError:
        return str(path)

SPDX_TOKEN = re.compile(
    r"(MIT-0|MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause-Clear|BSD-3-Clause|"
    r"ISC|0BSD|Unlicense|CC0-1\.0|Zlib|BSL-1\.0|BlueOak-1\.0\.0|"
    r"Unicode-3\.0|Unicode-DFS-2016|OpenSSL|Artistic-2\.0|NCSA|WTFPL|"
    r"MPL-2\.0|LGPL-2\.0-or-later|LGPL-2\.0|LGPL-2\.1-or-later|LGPL-2\.1|"
    r"LGPL-3\.0-or-later|LGPL-3\.0|GPL-2\.0-or-later|GPL-2\.0-only|GPL-2\.0|"
    r"GPL-3\.0-or-later|GPL-3\.0-only|GPL-3\.0|AGPL-3\.0-or-later|"
    r"AGPL-3\.0-only|AGPL-3\.0|SSPL-1\.1|SSPL-1\.0|BUSL-1\.1|"
    r"CC-BY-NC-SA-4\.0|CC-BY-NC-ND-4\.0|CC-BY-NC-4\.0|CC-BY-NC-3\.0|"
    r"CC-BY-NC-2\.0|CC-BY-NC-1\.0|CC-BY-SA-4\.0|CC-BY-4\.0|"
    r"CDLA-Permissive-2\.0|Commons-Clause)",
    re.IGNORECASE,
)


def load_policy() -> dict[str, Any]:
    return json.loads(POLICY_PATH.read_text(encoding="utf-8"))


def normalize_token(raw: str) -> str:
    t = raw.strip()
    aliases = {
        "APACHE-2.0": "Apache-2.0",
        "APACHE 2.0": "Apache-2.0",
        "APACHE-2": "Apache-2.0",
        "BSD": "BSD-3-Clause",
        "BSD-2": "BSD-2-Clause",
        "BSD-3": "BSD-3-Clause",
        "GPLV2": "GPL-2.0",
        "GPLV3": "GPL-3.0",
        "GPL-2": "GPL-2.0",
        "GPL-3": "GPL-3.0",
        "LGPLV2.1": "LGPL-2.1",
        "LGPLV3": "LGPL-3.0",
        "AGPLV3": "AGPL-3.0",
        "CC0": "CC0-1.0",
        "PUBLIC DOMAIN": "Unlicense",
    }
    key = t.upper().replace("_", "-")
    if key in aliases:
        return aliases[key]
    # Preserve canonical casing from match when possible
    m = SPDX_TOKEN.fullmatch(t)
    if m:
        # Re-match against known list casing via aliases map values
        for known in (
            "MIT",
            "Apache-2.0",
            "BSD-2-Clause",
            "BSD-3-Clause",
            "ISC",
            "0BSD",
            "Unlicense",
            "MPL-2.0",
        ):
            if known.lower() == t.lower():
                return known
        return t
    return t


def extract_spdx_tokens(expr: str | None) -> list[str]:
    if not expr or not str(expr).strip():
        return ["UNKNOWN"]
    text = str(expr).replace("/", " OR ").replace("|", " OR ")
    found = [normalize_token(m.group(0)) for m in SPDX_TOKEN.finditer(text)]
    return found or ["UNKNOWN"]


def classify_expression(
    expr: str | None, policy: dict[str, Any]
) -> tuple[str, list[str]]:
    """Return (allowed|review|forbidden|unknown, tokens).

    Dual-license OR: allowed if any alternative is allowed.
    AND-like (contains AND): allowed only if no token is forbidden and all are allowed/review.
    """
    linked = policy["linked_dependencies"]
    allowed = {x.lower() for x in linked["allowed"]}
    review = {x.lower() for x in linked["review"]}
    forbidden = {x.lower() for x in linked["forbidden"]}

    raw = (expr or "").strip()
    tokens = extract_spdx_tokens(raw)
    lower = [t.lower() for t in tokens]

    if any(t in forbidden for t in lower):
        # OR dual-license: if at least one alternative is allowed, treat as allowed
        if re.search(r"\bOR\b|/|\|", raw, re.I) and any(t in allowed for t in lower):
            return "allowed", tokens
        return "forbidden", tokens

    if all(t in allowed for t in lower):
        return "allowed", tokens
    if any(t in review or t == "unknown" for t in lower):
        return "review", tokens
    if any(t in allowed for t in lower) and re.search(r"\bOR\b|/|\|", raw, re.I):
        return "allowed", tokens
    return "unknown", tokens


def cargo_packages(manifest: Path) -> list[dict[str, Any]]:
    cmd = [
        "cargo",
        "metadata",
        "--format-version",
        "1",
        "--manifest-path",
        str(manifest),
        "--locked",
    ]
    try:
        proc = subprocess.run(
            cmd, check=True, capture_output=True, text=True, encoding="utf-8"
        )
    except FileNotFoundError as exc:
        raise SystemExit(f"cargo not found: {exc}") from exc
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(exc.stderr or exc.stdout or str(exc))
        raise SystemExit(f"cargo metadata failed ({exc.returncode})") from exc

    meta = json.loads(proc.stdout)
    workspace_members = set(meta.get("workspace_members") or [])
    out: list[dict[str, Any]] = []
    for pkg in meta.get("packages") or []:
        # Skip path-only workspace packages from classification noise if desired;
        # still include for completeness.
        out.append(
            {
                "ecosystem": "cargo",
                "name": pkg.get("name"),
                "version": pkg.get("version"),
                "license": pkg.get("license") or pkg.get("license_file") or "",
                "id": pkg.get("id"),
                "manifest_path": pkg.get("manifest_path"),
                "is_workspace_member": pkg.get("id") in workspace_members,
            }
        )
    return out


def npm_lock_packages(lock_path: Path, label: str) -> list[dict[str, Any]]:
    if not lock_path.is_file():
        return []
    data = json.loads(lock_path.read_text(encoding="utf-8"))
    packages = data.get("packages") or {}
    out: list[dict[str, Any]] = []
    for rel, info in packages.items():
        if not isinstance(info, dict):
            continue
        # Root package key is ""
        name = info.get("name")
        if not name:
            name = rel.replace("node_modules/", "") if rel else lock_path.parent.name
        if rel == "":
            continue  # skip workspace root entry; still inventory deps
        out.append(
            {
                "ecosystem": "npm",
                "tree": label,
                "name": name,
                "version": info.get("version") or "",
                "license": info.get("license") or "",
                "path": rel,
            }
        )
    # lockfileVersion 1 fallback
    if not packages and "dependencies" in data:
        def walk(deps: dict[str, Any], prefix: str = "") -> None:
            for name, info in deps.items():
                if not isinstance(info, dict):
                    continue
                out.append(
                    {
                        "ecosystem": "npm",
                        "tree": label,
                        "name": name,
                        "version": info.get("version") or "",
                        "license": info.get("license") or "",
                        "path": f"{prefix}{name}",
                    }
                )
                if "dependencies" in info:
                    walk(info["dependencies"], f"{prefix}{name}/")

        walk(data.get("dependencies") or {})
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help="JSON report path",
    )
    parser.add_argument(
        "--markdown",
        type=Path,
        default=None,
        help="Optional markdown summary path",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Fail on review/unknown as well as forbidden",
    )
    parser.add_argument(
        "--fail-on-forbidden",
        action="store_true",
        default=True,
        help=argparse.SUPPRESS,
    )
    args = parser.parse_args()

    policy = load_policy()
    rows: list[dict[str, Any]] = []

    cargo_manifest = ROOT / "src-tauri" / "Cargo.toml"
    if not cargo_manifest.is_file():
        print(f"Missing {cargo_manifest}", file=sys.stderr)
        return 2

    print("→ Collecting Cargo metadata (Cargo.lock)…")
    for pkg in cargo_packages(cargo_manifest):
        if pkg.get("is_workspace_member"):
            continue
        verdict, tokens = classify_expression(pkg.get("license"), policy)
        rows.append({**pkg, "verdict": verdict, "tokens": tokens})

    npm_locks = [
        (ROOT / "package-lock.json", "app-root"),
        (ROOT / "web" / "companion" / "package-lock.json", "companion"),
    ]
    for lock, label in npm_locks:
        print(f"→ Scanning {rel(lock)}…")
        for pkg in npm_lock_packages(lock, label):
            verdict, tokens = classify_expression(pkg.get("license"), policy)
            rows.append({**pkg, "verdict": verdict, "tokens": tokens})

    by_verdict = Counter(r["verdict"] for r in rows)
    forbidden = [r for r in rows if r["verdict"] == "forbidden"]
    review = [r for r in rows if r["verdict"] in {"review", "unknown"}]

    report = {
        "project_license": policy.get("project_license"),
        "policy": rel(POLICY_PATH),
        "counts": dict(by_verdict),
        "total_packages": len(rows),
        "forbidden": forbidden,
        "review": review,
        "packages": rows,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {rel(args.out)} ({len(rows)} packages)")
    print(
        "Summary:",
        ", ".join(f"{k}={v}" for k, v in sorted(by_verdict.items())),
    )

    if args.markdown:
        lines = [
            "# License inventory",
            "",
            f"- Project license: **{policy.get('project_license')}**",
            f"- Packages scanned: **{len(rows)}**",
            f"- Counts: `{dict(by_verdict)}`",
            "",
            "## Forbidden",
            "",
        ]
        if not forbidden:
            lines.append("_None_")
        else:
            lines.append("| Ecosystem | Name | Version | License |")
            lines.append("| --- | --- | --- | --- |")
            for r in forbidden:
                lines.append(
                    f"| {r.get('ecosystem')} | {r.get('name')} | {r.get('version')} | {r.get('license') or 'UNKNOWN'} |"
                )
        lines += ["", "## Review / unknown", ""]
        if not review:
            lines.append("_None_")
        else:
            lines.append("| Ecosystem | Name | Version | License | Verdict |")
            lines.append("| --- | --- | --- | --- | --- |")
            for r in review[:200]:
                lines.append(
                    f"| {r.get('ecosystem')} | {r.get('name')} | {r.get('version')} | {r.get('license') or 'UNKNOWN'} | {r.get('verdict')} |"
                )
            if len(review) > 200:
                lines.append(f"| … | ({len(review) - 200} more) | | | |")
        args.markdown.parent.mkdir(parents=True, exist_ok=True)
        args.markdown.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"Wrote {args.markdown}")

    if forbidden:
        print("FAIL: forbidden licenses in linked dependency graph:", file=sys.stderr)
        for r in forbidden[:30]:
            print(
                f"  - [{r.get('ecosystem')}] {r.get('name')}@{r.get('version')}: {r.get('license')}",
                file=sys.stderr,
            )
        return 1

    if args.strict and review:
        print("FAIL (--strict): review/unknown licenses present", file=sys.stderr)
        return 1

    print("OK: no forbidden linked licenses detected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
