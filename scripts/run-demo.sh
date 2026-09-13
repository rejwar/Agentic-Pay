#!/usr/bin/env bash
set -euo pipefail

cleanup() {
  echo ""
  echo "🛑 Stopping all AgenticPay demo services..."
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

# Ensure provider .env exists
if [ ! -f examples/pyth-provider/.env ] && [ -f examples/pyth-provider/.env.example ]; then
  cp examples/pyth-provider/.env.example examples/pyth-provider/.env
fi

echo "🚀 Starting AgenticPay Demo Services..."

echo "1. Starting Pyth Data Provider on http://localhost:8080..."
(cd examples/pyth-provider && npm run dev) &

echo "2. Starting Autonomous Agent Backend on http://localhost:8545..."
(cd agent-backend && cargo run --bin agent-backend) &

echo "3. Starting Frontend Web Dashboard on http://localhost:5173..."
(cd frontend && npm run dev) &

sleep 2
echo ""
echo "=================================================="
echo "🟢 Provider:  http://localhost:8080"
echo "🟢 Agent RPC: http://localhost:8545"
echo "🟢 Frontend:  http://localhost:5173"
echo "=================================================="
echo "Press Ctrl+C to stop all services."
wait
