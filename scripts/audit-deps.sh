#!/usr/bin/env bash
# Pre-build dependency vulnerability scan (cargo-audit + npm audit).
# Usage: ./scripts/audit-deps.sh [--strict] [--skip-install]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STRICT=0
SKIP_INSTALL=0
REPORT_DIR="${REPORT_DIR:-$ROOT/reports}"
mkdir -p "$REPORT_DIR"

for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    -h|--help)
      echo "Usage: $0 [--strict] [--skip-install]"
      exit 0
      ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }
status=0

ensure_cargo_audit() {
  if command -v cargo-audit >/dev/null 2>&1; then
    return 0
  fi
  if cargo install --list 2>/dev/null | grep -q '^cargo-audit '; then
    return 0
  fi
  if [[ "$SKIP_INSTALL" -eq 1 ]]; then
    echo "cargo-audit not found. Install: cargo install cargo-audit --locked" >&2
    exit 2
  fi
  step "Installing cargo-audit (cargo install --locked)"
  cargo install cargo-audit --locked
}

step "cargo audit (src-tauri/Cargo.lock)"
ensure_cargo_audit
(
  cd "$ROOT/src-tauri"
  cargo audit --json >"$REPORT_DIR/cargo-audit.json" 2>/dev/null || true
  cargo audit
) || {
  echo "cargo-audit reported vulnerabilities (see reports/cargo-audit.json)" >&2
  status=1
}

AUDIT_LEVEL="high"
if [[ "$STRICT" -eq 1 ]]; then
  AUDIT_LEVEL="moderate"
fi

npm_audit_tree() {
  local prefix="$1"
  local label="$2"
  if [[ ! -f "$prefix/package-lock.json" ]]; then
    echo "skip $label (no package-lock.json)"
    return 0
  fi
  step "npm audit ($label) — fail on ${AUDIT_LEVEL}+"
  (
    cd "$prefix"
    npm audit --json >"$REPORT_DIR/npm-audit-${label}.json" 2>/dev/null || true
    npm audit --audit-level="$AUDIT_LEVEL"
  ) || {
    echo "npm audit ($label) failed at audit-level=$AUDIT_LEVEL" >&2
    status=1
  }
}

npm_audit_tree "$ROOT" "app-root"
npm_audit_tree "$ROOT/web/companion" "companion"

echo
if [[ "$status" -ne 0 ]]; then
  echo "Dependency audit FAILED." >&2
  exit 1
fi

echo "Dependency audit PASSED (cargo-audit + npm audit)."
exit 0
