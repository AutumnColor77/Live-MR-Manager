#!/usr/bin/env bash
# Full license inventory + AI/Alignment model compatibility gate.
# Usage: ./scripts/check-licenses.sh [--strict]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
REPORT_DIR="$ROOT/reports"
mkdir -p "$REPORT_DIR"

PYTHON="${PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || PYTHON=python

STRICT_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT_ARGS+=(--strict) ;;
  esac
done

echo "==> License inventory (Cargo.lock + package-lock.json)"
"$PYTHON" "$ROOT/scripts/supply-chain/inventory_licenses.py" \
  --out "$REPORT_DIR/license-inventory.json" \
  --markdown "$REPORT_DIR/license-inventory.md" \
  "${STRICT_ARGS[@]+"${STRICT_ARGS[@]}"}"

echo
echo "==> Model / MIT compatibility (MODEL_LICENSING + notices + Rust catalogs)"
MODEL_EXTRA=()
if ((${#STRICT_ARGS[@]} > 0)); then
  MODEL_EXTRA+=(--strict-provisional)
fi
"$PYTHON" "$ROOT/scripts/supply-chain/check_model_license_compat.py" \
  --out "$REPORT_DIR/model-license-compat.json" \
  "${MODEL_EXTRA[@]+"${MODEL_EXTRA[@]}"}"

echo
echo "License checks PASSED. Reports in $REPORT_DIR"
