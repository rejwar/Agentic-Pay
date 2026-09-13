#!/usr/bin/env bash
set -euo pipefail

RPC_URL="${SOLANA_RPC_URL:-http://127.0.0.1:8899}"
AGENT_KEY="${1:-}"

if [ -z "$AGENT_KEY" ]; then
  if [ -n "${AGENT_PUBKEY:-}" ]; then
    AGENT_KEY="$AGENT_PUBKEY"
  else
    echo "Usage: ./scripts/fund-agent.sh <AGENT_PUBKEY_OR_SECRET>"
    echo "Or set AGENT_PUBKEY in your environment."
    exit 1
  fi
fi

echo "==> Requesting 2 SOL airdrop on ${RPC_URL} for ${AGENT_KEY}..."
solana airdrop 2 "${AGENT_KEY}" --url "${RPC_URL}" || {
  echo "⚠️ Airdrop request failed or timed out. Ensure local validator is running or use devnet faucet."
  exit 1
}

echo "✅ Airdrop complete. Current balance:"
solana balance "${AGENT_KEY}" --url "${RPC_URL}"
