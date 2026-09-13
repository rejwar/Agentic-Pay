#!/usr/bin/env bash
set -euo pipefail

HERMES_URL="${PYTH_HERMES_URL:-https://hermes.pyth.network}"
SYMBOL="${1:-SOL/USD}"

echo "==> Querying Pyth Hermes oracle at ${HERMES_URL} for ${SYMBOL}..."
curl -s "${HERMES_URL}/v2/price_feeds?query=${SYMBOL}" | grep -o '"id":"[^"]*"' | head -n 5 || {
  echo "Known Pyth Price Feed IDs:"
  echo "  BTC/USD: 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"
  echo "  ETH/USD: 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
  echo "  SOL/USD: 0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"
}
