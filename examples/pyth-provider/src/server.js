"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const web3_js_1 = require("@solana/web3.js");
const provider_1 = require("@agenticpay/provider");
const pyth_1 = require("./pyth");
const PORT = Number(process.env.PORT ?? 8080);
const PROVIDER_PUBKEY = process.env.PROVIDER_PUBKEY;
if (!PROVIDER_PUBKEY) {
    console.error("PROVIDER_PUBKEY env var is required");
    process.exit(1);
}
const PRICE_LAMPORTS = BigInt(process.env.PRICE_LAMPORTS ?? "1000");
const provider = new web3_js_1.PublicKey(PROVIDER_PUBKEY);
const nonceStore = new provider_1.InMemoryNonceStore();
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});
app.get("/health", (_req, res) => {
    res.json({ status: "ok", provider: provider.toBase58() });
});
app.get("/price/:symbol", (0, provider_1.agenticPay)({
    provider,
    price: PRICE_LAMPORTS,
    ttlSeconds: 60,
    network: "solana",
    scheme: "agenticpay_x402v1",
    nonceStore,
    onVerified: (v) => {
        console.log(`✅ Voucher accepted — nonce=${v.nonce} agent=${v.agent.toBase58().slice(0, 8)}… amount=${v.amountLamports}`);
    },
}), async (req, res) => {
    try {
        const symbol = req.params.symbol.toUpperCase();
        const price = await (0, pyth_1.fetchPrice)(symbol);
        res.json(price);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.listen(PORT, "127.0.0.1", () => {
    console.log("==================================================");
    console.log(`🚀 Pyth Provider (AgenticPay SDK) on port ${PORT}`);
    console.log(`🔑 Provider: ${provider.toBase58()}`);
    console.log(`💰 Price:    ${PRICE_LAMPORTS} lamports / request`);
    console.log(`🌐 Health:   http://127.0.0.1:${PORT}/health`);
    console.log(`🔒 Gated:    http://127.0.0.1:${PORT}/price/BTC`);
    console.log("==================================================");
});
