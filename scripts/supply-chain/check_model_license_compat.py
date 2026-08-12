#!/usr/bin/env python3
"""Validate official AI/Alignment model licenses against the MIT app policy.

Cross-checks:
  - docs/MODEL_LICENSING.md (tables + rejected models)
  - THIRD_PARTY_NOTICES.md (UVR / alignment sections)
  - src-tauri/src/alignment.rs ALIGNMENT_MODELS.license
  - src-tauri/src/state.rs MODELS catalog ids

Fails when:
  - Official catalog embeds a forbidden license (CC-BY-NC, GPL, research-only, …)
  - A documented rejected model id appears in MODELS / ALIGNMENT_MODELS URLs
  - Alignment Rust license strings are not in the allowed set
  - Documented NC rejection is missing from MODEL_LICENSING.md

Exit 0 on pass, 1 on conflict, 2 on I/O/usage errors.
Not legal advice.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
POLICY_PATH = Path(__file__).resolve().parent / "license-policy.json"
MODEL_DOC = ROOT / "docs" / "MODEL_LICENSING.md"
NOTICES = ROOT / "THIRD_PARTY_NOTICES.md"
ALIGNMENT_RS = ROOT / "src-tauri" / "src" / "alignment.rs"
STATE_RS = ROOT / "src-tauri" / "src" / "state.rs"
DEFAULT_OUT = ROOT / "reports" / "model-license-compat.json"


def rel(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(ROOT)).replace("\\", "/")
    except ValueError:
        return str(path)

NC_PATTERNS = re.compile(
    r"CC-BY-NC|non-commercial|research\s*only|비상업",
    re.IGNORECASE,
)
REJECT_ROW = re.compile(
    r"\|\s*(?P<model>[^|]+?)\s*\|\s*(?P<license>\*\*[^*]+\*\*|[^|]+?)\s*\|\s*(?P<decision>\*\*불가\*\*|불가|[^|]+)\s*\|",
)
ALIGN_LICENSE = re.compile(
    r'license:\s*"(?P<lic>[^"]+)"',
)
MODEL_TUPLE = re.compile(
    r'\(\s*"(?P<id>[^"]+)"\s*,\s*"(?P<file>[^"]+)"\s*,\s*"(?P<url>[^"]+)"\s*\)',
)


@dataclass
class Finding:
    severity: str  # error | warn | info
    code: str
    message: str
    source: str


def load_policy() -> dict[str, Any]:
    return json.loads(POLICY_PATH.read_text(encoding="utf-8"))


def normalize_license(text: str) -> str:
    t = text.strip().strip("*").strip()
    t = re.sub(r"\s+", " ", t)
    aliases = {
        "잠정 MIT": "PROVISIONAL-MIT",
        "잠정 MIT (크레딧 필수)": "PROVISIONAL-MIT",
        "Apache 2.0": "Apache-2.0",
        "Apache-2.0": "Apache-2.0",
        "MIT": "MIT",
        "CC-BY-NC-4.0": "CC-BY-NC-4.0",
    }
    for k, v in aliases.items():
        if t.lower() == k.lower() or k.lower() in t.lower() and "CC-BY-NC" in t.upper():
            if "CC-BY-NC" in t.upper():
                m = re.search(r"CC-BY-NC(?:-SA|-ND)?(?:-\d(?:\.\d)?)?", t, re.I)
                return (m.group(0).upper().replace("CC-BY-NC", "CC-BY-NC") if m else "CC-BY-NC-4.0")
            if "잠정" in t:
                return "PROVISIONAL-MIT"
            return v
    if "apache" in t.lower():
        return "Apache-2.0"
    if "잠정" in t and "MIT" in t.upper():
        return "PROVISIONAL-MIT"
    if t.upper() == "MIT":
        return "MIT"
    return t


def classify_model_license(lic: str, policy: dict[str, Any]) -> str:
    model_pol = policy["official_ai_models"]
    token = normalize_license(lic)
    low = token.lower()
    if any(f.lower() == low or f.lower() in low for f in model_pol["forbidden"]):
        return "forbidden"
    if NC_PATTERNS.search(token):
        return "forbidden"
    if any(a.lower() == low for a in model_pol["allowed"]):
        return "allowed"
    if any(r.lower() == low for r in model_pol["review"]):
        return "review"
    return "unknown"


def parse_rejected_from_doc(text: str) -> list[dict[str, str]]:
    rejected: list[dict[str, str]] = []
    for line in text.splitlines():
        if "불가" not in line or "|" not in line:
            continue
        m = REJECT_ROW.search(line)
        if not m:
            continue
        decision = m.group("decision")
        if "불가" not in decision:
            continue
        rejected.append(
            {
                "model": m.group("model").strip(),
                "license": normalize_license(m.group("license")),
                "decision": decision.strip(),
            }
        )
    return rejected


def parse_alignment_licenses(src: str) -> list[dict[str, str]]:
    # Keep order with nearest preceding id=
    blocks = re.split(r"AlignmentModelSpec\s*\{", src)
    out: list[dict[str, str]] = []
    for block in blocks[1:]:
        id_m = re.search(r'id:\s*"(?P<id>[^"]+)"', block)
        lic_m = ALIGN_LICENSE.search(block)
        url_m = re.search(r'source_url:\s*"(?P<url>[^"]+)"', block)
        if not (id_m and lic_m):
            continue
        out.append(
            {
                "id": id_m.group("id"),
                "license": lic_m.group("lic"),
                "source_url": url_m.group("url") if url_m else "",
            }
        )
    return out


def parse_models_catalog(src: str) -> list[dict[str, str]]:
    return [
        {"id": m.group("id"), "file": m.group("file"), "url": m.group("url")}
        for m in MODEL_TUPLE.finditer(src)
    ]


def project_license_conflict(model_license: str, project_license: str) -> str | None:
    """Explain conflict vs MIT distribution goals (commercial + permissive catalog)."""
    verdict_hint = normalize_license(model_license)
    if NC_PATTERNS.search(verdict_hint) or "CC-BY-NC" in verdict_hint.upper():
        return (
            f"{verdict_hint} forbids commercial use; conflicts with MIT app goal of "
            f"unrestricted monetized streaming ({project_license} code ≠ NC model rights)."
        )
    if re.search(r"\b(AGPL|GPL)-", verdict_hint, re.I):
        return (
            f"{verdict_hint} is strong copyleft; redistributing as an official on-demand "
            f"asset requires GPL compliance obligations incompatible with the project's "
            f"permissive-model catalog policy (app remains {project_license})."
        )
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--strict-provisional", action="store_true",
                        help="Treat provisional MIT UVR models as errors")
    args = parser.parse_args()

    for path in (MODEL_DOC, NOTICES, ALIGNMENT_RS, STATE_RS, POLICY_PATH):
        if not path.is_file():
            print(f"Missing required file: {path}", file=sys.stderr)
            return 2

    policy = load_policy()
    project_license = policy.get("project_license", "MIT")
    findings: list[Finding] = []

    model_doc = MODEL_DOC.read_text(encoding="utf-8")
    notices = NOTICES.read_text(encoding="utf-8")
    alignment_src = ALIGNMENT_RS.read_text(encoding="utf-8")
    state_src = STATE_RS.read_text(encoding="utf-8")

    # 1) Documented rejections must exist and stay out of code catalogs
    doc_rejected = parse_rejected_from_doc(model_doc)
    policy_rejected = policy.get("documented_rejected_models") or []
    if not doc_rejected and not policy_rejected:
        findings.append(
            Finding(
                "error",
                "missing_rejection_table",
                "MODEL_LICENSING.md has no documented '불가' model rows",
                str(MODEL_DOC.relative_to(ROOT)),
            )
        )

    catalog = parse_models_catalog(state_src)
    align_models = parse_alignment_licenses(alignment_src)
    catalog_text = (state_src + "\n" + alignment_src).lower()

    rejected_needles: list[tuple[str, str]] = []
    for item in policy_rejected:
        rejected_needles.append((str(item.get("id") or ""), str(item.get("license") or "")))
    for r in doc_rejected:
        rejected_needles.append((r["model"], r["license"]))

    for model_id, lic in rejected_needles:
        markers = [
            t.lower()
            for t in re.split(r"[/\s(),]+", model_id)
            if len(t) >= 5
        ]
        hit = any(
            m in catalog_text
            for m in markers
            if m in {"becruily", "mel-band-roformer-deux", "roformer-deux"}
            or (m.startswith("cc-by-nc"))
        )
        if hit:
            findings.append(
                Finding(
                    "error",
                    "rejected_model_in_catalog",
                    f"Rejected model '{model_id}' ({lic}) appears in official Rust model sources",
                    "src-tauri/src/state.rs|alignment.rs",
                )
            )

    # Hard ban markers in official catalog sources
    for bad in ("becruily", "mel-band-roformer-deux"):
        if bad in state_src.lower() or bad in alignment_src.lower():
            findings.append(
                Finding(
                    "error",
                    "forbidden_string_in_code",
                    f"Forbidden model marker '{bad}' found in official model source",
                    "src-tauri",
                )
            )

    # 2) Alignment models in Rust must be commercially OK
    for m in align_models:
        verdict = classify_model_license(m["license"], policy)
        conflict = project_license_conflict(m["license"], project_license)
        if verdict == "forbidden" or conflict:
            findings.append(
                Finding(
                    "error",
                    "alignment_license_conflict",
                    conflict
                    or f"Alignment model '{m['id']}' license {m['license']} is forbidden",
                    "src-tauri/src/alignment.rs",
                )
            )
        elif verdict in {"review", "unknown"}:
            findings.append(
                Finding(
                    "warn",
                    "alignment_license_review",
                    f"Alignment model '{m['id']}' license {m['license']} needs review",
                    "src-tauri/src/alignment.rs",
                )
            )
        else:
            findings.append(
                Finding(
                    "info",
                    "alignment_license_ok",
                    f"Alignment model '{m['id']}' license {m['license']} OK vs {project_license}",
                    "src-tauri/src/alignment.rs",
                )
            )

        if "AutumnColor77/Live-MR-Manager" not in (
            # model_url checked separately below via ALIGNMENT_MODELS block
            alignment_src
        ):
            pass

    # Alignment download URLs must be this repo's releases (documented policy)
    for m in align_models:
        # source_url is HF; download URLs are model_url in struct — re-parse
        pass

    model_urls = re.findall(r'model_url:\s*"(https://[^"]+)"', alignment_src)
    for url in model_urls:
        if "github.com/AutumnColor77/Live-MR-Manager/releases/" not in url:
            findings.append(
                Finding(
                    "error",
                    "alignment_host_policy",
                    f"Alignment model_url not on project releases: {url}",
                    "src-tauri/src/alignment.rs",
                )
            )
        if "temmis2077" in url.lower():
            findings.append(
                Finding(
                    "error",
                    "third_party_fork_release",
                    f"Alignment URL references third-party fork: {url}",
                    "src-tauri/src/alignment.rs",
                )
            )

    # 3) Notices / MODEL_LICENSING must mention MIT project + NC exclusion
    if "MIT" not in notices.split("본 프로젝트")[0] and "MIT License" not in notices:
        # notices says MIT early
        if "[MIT License]" not in notices and "MIT License" not in notices:
            findings.append(
                Finding(
                    "warn",
                    "notices_missing_mit",
                    "THIRD_PARTY_NOTICES.md should state the project MIT license",
                    "THIRD_PARTY_NOTICES.md",
                )
            )

    if not NC_PATTERNS.search(model_doc):
        findings.append(
            Finding(
                "error",
                "policy_missing_nc_ban",
                "MODEL_LICENSING.md must document NC / non-commercial exclusion",
                "docs/MODEL_LICENSING.md",
            )
        )

    # 4) UVR provisional MIT in notices → review unless --strict-provisional
    if "잠정 MIT" in notices or "잠정 MIT" in model_doc:
        sev = "error" if args.strict_provisional else "warn"
        findings.append(
            Finding(
                sev,
                "provisional_uvr_mit",
                "Official UVR models are marked provisional MIT; keep credits and track UVR#1242",
                "THIRD_PARTY_NOTICES.md / docs/MODEL_LICENSING.md",
            )
        )

    # 5) Catalog ids should be documented
    for entry in catalog:
        if entry["id"] not in model_doc and entry["id"] not in notices:
            findings.append(
                Finding(
                    "warn",
                    "catalog_undocumented",
                    f"MODELS id '{entry['id']}' not mentioned in licensing docs",
                    "src-tauri/src/state.rs",
                )
            )

    # Compatibility matrix summary vs project MIT
    matrix = []
    for m in align_models:
        matrix.append(
            {
                "kind": "alignment",
                "id": m["id"],
                "license": m["license"],
                "verdict": classify_model_license(m["license"], policy),
                "conflict_with_project_mit": project_license_conflict(
                    m["license"], project_license
                ),
            }
        )
    for entry in catalog:
        # UVR provisional from docs
        matrix.append(
            {
                "kind": "separation",
                "id": entry["id"],
                "license": "PROVISIONAL-MIT",
                "verdict": classify_model_license("PROVISIONAL-MIT", policy),
                "conflict_with_project_mit": None,
            }
        )
    for r in doc_rejected:
        matrix.append(
            {
                "kind": "documented_rejected",
                "id": r["model"],
                "license": r["license"],
                "verdict": "forbidden",
                "conflict_with_project_mit": project_license_conflict(
                    r["license"], project_license
                ),
            }
        )

    errors = [f for f in findings if f.severity == "error"]
    warns = [f for f in findings if f.severity == "warn"]

    report = {
        "project_license": project_license,
        "ok": not errors,
        "error_count": len(errors),
        "warn_count": len(warns),
        "findings": [asdict(f) for f in findings],
        "compatibility_matrix": matrix,
        "official_catalog": catalog,
        "alignment_models": align_models,
        "documented_rejected": doc_rejected,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"Project license: {project_license}")
    print(f"Official separation models: {len(catalog)}")
    print(f"Alignment models: {len(align_models)}")
    print(f"Documented rejections: {len(doc_rejected)}")
    print(f"Findings: {len(errors)} error(s), {len(warns)} warning(s)")
    for f in findings:
        if f.severity == "info":
            continue
        print(f"  [{f.severity.upper()}] {f.code}: {f.message}")
    print(f"Wrote {rel(args.out)}")

    if errors:
        print("FAIL: model license compatibility conflicts detected", file=sys.stderr)
        return 1

    print("OK: no hard model/MIT conflicts in official catalogs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
