#!/usr/bin/env bash
# Standard startup and verification path for the harness repository (AGENTS.md → Clock-in).
#   ./init.sh          install + wiring check + L1 baseline (`pnpm check`)
#   FAST=1 ./init.sh   skip the baseline (tooling and wiring only)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

step "Working directory: $PWD"

step "Tooling"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed; install Node 22 or newer (package.json → engines)." >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is missing; run: corepack enable" >&2
  exit 1
fi
echo "node $(node -v | tr -d v) · pnpm $(pnpm -v)"

step "Installing dependencies"
pnpm install --frozen-lockfile

step "Harness wiring"
pnpm harness:doctor

if [ "${FAST:-0}" = "1" ]; then
  step "FAST=1 — skipping baseline verification"
else
  step "Baseline verification (L1): pnpm check"
  pnpm check
fi
