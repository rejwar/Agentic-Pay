import express from "express";
import { PublicKey } from "@solana/web3.js";
import { agenticPay, InMemoryNonceStore } from "../src";

const app = express();
const provider = new PublicKey("11111111111111111111111111111111");

app.use(express.json());

// Gate an endpoint: 1,000 lamports per request
app.get(
  "/api/data",
  agenticPay({
    provider,
    price: 1_000n,
    ttlSeconds: 60,
    nonceStore: new InMemoryNonceStore(),
    onVerified: (voucher) => {
      console.log(`Verified voucher: nonce=${voucher.nonce}, agent=${voucher.agent.toBase58()}`);
    },
  }),
  (req, res) => {
    res.json({
      success: true,
      message: "Hello from paid resource!",
      voucherNonce: req.agenticPay?.nonce.toString(),
    });
  },
);

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Provider listening on http://localhost:${PORT}`);
});
