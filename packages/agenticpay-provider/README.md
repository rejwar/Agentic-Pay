# @agenticpay/provider

Drop-in x402 paywall middleware for Solana AgenticPay vouchers.

Gate your Express APIs with autonomous agent micropayments on Solana. Agents pay with 105-byte self-certifying signed vouchers (`agenticpay_x402v1`), verified locally in under 1ms with Ed25519 signatures and replay protection.

## Installation

```bash
npm install @agenticpay/provider @solana/web3.js express
```

## Quick Start

```typescript
import express from "express";
import { PublicKey } from "@solana/web3.js";
import { agenticPay } from "@agenticpay/provider";

const app = express();
const provider = new PublicKey("YOUR_SOLANA_PROVIDER_WALLET_PUBKEY");

// Gate an endpoint: 1,000 lamports per request
app.get(
  "/api/data",
  agenticPay({
    provider,
    price: 1000n, // lamports
    ttlSeconds: 60,
  }),
  (req, res) => {
    // req.agenticPay contains verified voucher details
    console.log("Verified voucher from agent:", req.agenticPay.agent.toBase58());
    res.json({ data: "Autonomous agent paywalled data" });
  }
);

app.listen(8080);
```

## How It Works

1. **Client Request**: Client queries `/api/data` without credentials.
2. **402 Payment Required**: The middleware responds with HTTP 402 and the header:
   ```http
   PAYMENT-REQUIRED: {"price":1000,"network":"solana","recipient":"...","ttl":60,"scheme":"agenticpay_x402v1"}
   ```
3. **Agent Signs Voucher**: The autonomous agent signs a 105-byte canonical voucher with its Ed25519 keypair.
4. **Retry with Payment**: Client repeats the request with the base64-encoded voucher in the `PAYMENT-SIGNATURE` header.
5. **Local Verification**: The middleware decodes the payload, verifies:
   - Domain separator (`agenticpay_x402v1`)
   - Provider recipient matches configuration
   - Amount is $\ge$ requested price
   - Voucher timestamp is within TTL
   - Ed25519 signature over the canonical message
   - Nonce is not replayed via `NonceStore`
6. **Pass Through**: Successful requests attach `req.agenticPay` and invoke `next()`.

## Nonce Stores

By default, `@agenticpay/provider` uses `InMemoryNonceStore` with automatic TTL cleanup, suitable for single-process setups.

For multi-server or multi-region production setups, implement the simple `NonceStore` interface backed by Redis:

```typescript
export interface NonceStore {
  has(nonce: bigint): boolean | Promise<boolean>;
  mark(nonce: bigint, expiresAtMs: number): boolean | Promise<boolean>;
}
```

## Error Codes

When verification fails, HTTP 402 is returned with a JSON payload:
```json
{
  "error": "Ed25519 verification failed",
  "code": "VOUCHER_BAD_SIGNATURE"
}
```

Possible codes:
- `PAYMENT_REQUIRED` - Header missing
- `VOUCHER_MALFORMED` - Invalid Base64 or wire length
- `VOUCHER_EXPIRED` - Current timestamp exceeds `expiresAt`
- `VOUCHER_WRONG_PROVIDER` - Recipient pubkey mismatch
- `VOUCHER_INSUFFICIENT` - Amount is below price
- `VOUCHER_BAD_SIGNATURE` - Ed25519 signature verification failed
- `NONCE_REPLAY` - Nonce was already consumed
- `INTERNAL_ERROR` - Unhandled internal error

## License

MIT
