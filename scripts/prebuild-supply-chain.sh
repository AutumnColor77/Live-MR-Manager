#!/usr/bin/env bash
# One-shot pre-build supply-chain gate: licenses + vulnerability audits.
# Usage: ./scripts/prebuild-supply-chain.sh [--strict]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STRICT_FLAG=()
AUDIT_FLAG=()
for arg in "$@"; do
  case "$arg" in
    --strict)
      STRICT_FLAG+=(--strict)
      AUDIT_FLAG+=(--strict)
      ;;
  esac
done

"$ROOT/scripts/check-licenses.sh" "${STRICT_FLAG[@]+"${STRICT_FLAG[@]}"}"
"$ROOT/scripts/audit-deps.sh" "${AUDIT_FLAG[@]+"${AUDIT_FLAG[@]}"}"

echo
echo "Pre-build supply-chain gate PASSED."
