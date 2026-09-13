#!/usr/bin/env bash
set -euo pipefail

echo "==> Checking prerequisites..."
command -v cargo >/dev/null 2>&1 || { echo "❌ cargo not found. Please install Rust."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ node not found. Please install Node 18+."; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

if [ ! -f .env ] && [ -f .env.example ]; then
  echo "==> Creating default .env from .env.example..."
  cp .env.example .env
fi

echo "==> Building packages/agenticpay-provider..."
(cd packages/agenticpay-provider && npm install && npm run build)

echo "==> Installing examples/pyth-provider..."
(cd examples/pyth-provider && npm install)

echo "==> Building agent-backend..."
(cd agent-backend && cargo build)

if command -v anchor >/dev/null 2>&1; then
  echo "==> Verifying programs/agenticpay-guardrails..."
  (cd programs/agenticpay-guardrails && cargo check --offline || cargo check)
fi

echo "==> Building frontend..."
(cd frontend && npm install && npm run build)

echo "✅ Setup complete."
