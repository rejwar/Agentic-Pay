import "dotenv/config";
import express from "express";
import { PublicKey } from "@solana/web3.js";
import { agenticPay, InMemoryNonceStore } from "@agenticpay/provider";
import { fetchPrice } from "./pyth";

const PORT = Number(process.env.PORT ?? 8080);
const PROVIDER_PUBKEY = process.env.PROVIDER_PUBKEY;
if (!PROVIDER_PUBKEY) {
  console.error("PROVIDER_PUBKEY env var is required");
  process.exit(1);
}
const PRICE_LAMPORTS = BigInt(process.env.PRICE_LAMPORTS ?? "1000");

const provider = new PublicKey(PROVIDER_PUBKEY);
const nonceStore = new InMemoryNonceStore();

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", provider: provider.toBase58() });
});

app.get(
  "/price/:symbol",
  agenticPay({
    provider,
    price: PRICE_LAMPORTS,
    ttlSeconds: 60,
    network: "solana",
    scheme: "agenticpay_x402v1",
    nonceStore,
    onVerified: (v) => {
      console.log(
        `✅ Voucher accepted — nonce=${v.nonce} agent=${v.agent.toBase58().slice(0, 8)}… amount=${v.amountLamports}`,
      );
    },
  }),
  async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const price = await fetchPrice(symbol);
      res.json(price);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

app.listen(PORT, "127.0.0.1", () => {
  console.log("==================================================");
  console.log(`🚀 Pyth Provider (AgenticPay SDK) on port ${PORT}`);
  console.log(`🔑 Provider: ${provider.toBase58()}`);
  console.log(`💰 Price:    ${PRICE_LAMPORTS} lamports / request`);
  console.log(`🌐 Health:   http://127.0.0.1:${PORT}/health`);
  console.log(`🔒 Gated:    http://127.0.0.1:${PORT}/price/BTC`);
  console.log("==================================================");
});
