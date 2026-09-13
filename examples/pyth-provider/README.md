# Pyth Provider — Reference Example

A minimal API provider that gates Pyth Hermes price data behind an `@agenticpay/provider` paywall.

## Why this exists

This is the reference implementation of the AgenticPay **Provider SDK**.
Copy this pattern to make any HTTP API machine-payable by autonomous agents:

```typescript
import { agenticPay } from "@agenticpay/provider";

app.get(
  "/price/:symbol",
  agenticPay({
    provider: new PublicKey("YOUR_PROVIDER_PUBKEY"),
    price: 1000n, // lamports
    ttlSeconds: 60,
  }),
  async (req, res) => {
    // Fulfil paid request
    const price = await fetchPrice(req.params.symbol);
    res.json(price);
  }
);
```

## Running the Example

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and set your provider Solana public key:
   ```bash
   cp .env.example .env
   ```

3. Start the server:
   ```bash
   npm run dev
   ```

4. Test unauthenticated request (returns 402 Payment Required):
   ```bash
   curl -i http://127.0.0.1:8080/price/BTC
   ```
