import request from "supertest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { createApp } from "../src/server";
import {
  createCanonicalMessage,
  encodeVoucherHeader,
  decodeVoucherHeader,
  verifyVoucher,
  VoucherPayload,
  DOMAIN_SEPARATOR,
  CANONICAL_MESSAGE_LEN,
  VOUCHER_TOTAL_LEN,
} from "../src/voucher";
import { usedNonces, sweepExpiredNonces, nonceKey } from "../src/paywall";

describe("x402 Paywall & Resource Server Integration", () => {
  const providerKeypair = Keypair.generate();
  const agentKeypair = Keypair.generate();
  const pricePerRequest = BigInt(1000);

  const { app } = createApp({
    providerKeypair,
    pricePerRequestLamports: pricePerRequest,
    voucherTtlSecs: 60,
  });

  function signVoucher(
    nonce: bigint,
    agent: Keypair,
    provider: Keypair,
    amountLamports: bigint,
    expiresAt: bigint,
    retryCount: number = 0
  ): { voucher: VoucherPayload; header: string } {
    const canonical = createCanonicalMessage(
      nonce,
      agent.publicKey.toBuffer(),
      provider.publicKey.toBuffer(),
      amountLamports,
      expiresAt
    );

    const sig = nacl.sign.detached(
      new Uint8Array(canonical),
      agent.secretKey
    );

    const voucher: VoucherPayload = {
      nonce,
      agent: agent.publicKey.toBuffer(),
      provider: provider.publicKey.toBuffer(),
      amountLamports,
      expiresAt,
      signature: Buffer.from(sig),
      retryCount,
    };

    const header = encodeVoucherHeader(voucher);
    return { voucher, header };
  }

  describe("Canonical byte layout", () => {
    it("matches exact 105-byte canonical layout with domain separator", () => {
      const now = BigInt(Math.floor(Date.now() / 1000) + 60);
      const msg = createCanonicalMessage(
        BigInt(42),
        agentKeypair.publicKey.toBuffer(),
        providerKeypair.publicKey.toBuffer(),
        pricePerRequest,
        now
      );

      expect(msg.length).toBe(CANONICAL_MESSAGE_LEN);
      expect(msg.subarray(0, 17)).toEqual(DOMAIN_SEPARATOR);
      expect(msg.readBigUInt64LE(17)).toBe(BigInt(42));
      expect(msg.subarray(25, 57)).toEqual(agentKeypair.publicKey.toBuffer());
      expect(msg.subarray(57, 89)).toEqual(providerKeypair.publicKey.toBuffer());
      expect(msg.readBigUInt64LE(89)).toBe(pricePerRequest);
      expect(msg.readBigInt64LE(97)).toBe(now);
    });

    it("round-trips header serialization and deserialization", () => {
      const now = BigInt(Math.floor(Date.now() / 1000) + 60);
      const { voucher, header } = signVoucher(
        BigInt(101),
        agentKeypair,
        providerKeypair,
        pricePerRequest,
        now,
        2
      );

      const decoded = decodeVoucherHeader(header);
      expect(decoded.nonce).toBe(voucher.nonce);
      expect(decoded.agent).toEqual(voucher.agent);
      expect(decoded.provider).toEqual(voucher.provider);
      expect(decoded.amountLamports).toBe(voucher.amountLamports);
      expect(decoded.expiresAt).toBe(voucher.expiresAt);
      expect(decoded.signature).toEqual(voucher.signature);
      expect(decoded.retryCount).toBe(2);
      expect(verifyVoucher(decoded)).toBe(true);
    });
  });

  describe("Health endpoint", () => {
    it("returns 200 OK without payment required", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.provider).toBe(providerKeypair.publicKey.toBase58());
      expect(res.body.supportedSymbols).toContain("BTC");
    });
  });

  describe("x402 Payment Challenges", () => {
    it("returns 402 with PAYMENT-REQUIRED header when payment signature is missing", async () => {
      const res = await request(app).get("/price/BTC");

      expect(res.status).toBe(402);
      expect(res.headers["payment-required"]).toBeDefined();

      const paymentTerms = JSON.parse(res.headers["payment-required"]);
      expect(paymentTerms.price).toBe(1000);
      expect(paymentTerms.network).toBe("solana");
      expect(paymentTerms.recipient).toBe(providerKeypair.publicKey.toBase58());
      expect(paymentTerms.scheme).toBe("agenticpay_x402v1");
      expect(res.body.error).toBe("Payment Required");
    });

    it("accepts valid signed voucher and returns price data with payment receipt", async () => {
      const now = BigInt(Math.floor(Date.now() / 1000) + 60);
      const { header } = signVoucher(
        BigInt(1),
        agentKeypair,
        providerKeypair,
        pricePerRequest,
        now
      );

      const res = await request(app)
        .get("/price/BTC")
        .set("PAYMENT-SIGNATURE", header);

      expect(res.status).toBe(200);
      expect(res.body.symbol).toBe("BTC");
      expect(res.body.price).toBeGreaterThan(0);
      expect(res.body.payment).toBeDefined();
      expect(res.body.payment.status).toBe("verified");
      expect(res.body.payment.agent).toBe(agentKeypair.publicKey.toBase58());
      expect(res.body.payment.provider).toBe(providerKeypair.publicKey.toBase58());
    });

    it("rejects voucher with invalid signature", async () => {
      const now = BigInt(Math.floor(Date.now() / 1000) + 60);
      const { voucher } = signVoucher(
        BigInt(1),
        agentKeypair,
        providerKeypair,
        pricePerRequest,
        now
      );

      // Tamper signature
      voucher.signature[0] ^= 0xff;
      const tamperedHeader = encodeVoucherHeader(voucher);

      const res = await request(app)
        .get("/price/BTC")
        .set("PAYMENT-SIGNATURE", tamperedHeader);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Invalid voucher signature");
    });

    it("rejects expired voucher", async () => {
      const pastTime = BigInt(Math.floor(Date.now() / 1000) - 100);
      const { header } = signVoucher(
        BigInt(2),
        agentKeypair,
        providerKeypair,
        pricePerRequest,
        pastTime
      );

      const res = await request(app)
        .get("/price/BTC")
        .set("PAYMENT-SIGNATURE", header);

      expect(res.status).toBe(402);
      expect(res.body.error).toBe("Voucher expired");
    });

    it("rejects voucher when provider mismatches", async () => {
      const anotherProvider = Keypair.generate();
      const now = BigInt(Math.floor(Date.now() / 1000) + 60);
      const { header } = signVoucher(
        BigInt(3),
        agentKeypair,
        anotherProvider, // wrong provider
        pricePerRequest,
        now
      );

      const res = await request(app)
        .get("/price/BTC")
        .set("PAYMENT-SIGNATURE", header);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Provider mismatch");
    });

    it("rejects voucher when payment amount is insufficient", async () => {
      const now = BigInt(Math.floor(Date.now() / 1000) + 60);
      const { header } = signVoucher(
        BigInt(4),
        agentKeypair,
        providerKeypair,
        BigInt(500), // less than required 1000
        now
      );

      const res = await request(app)
        .get("/price/BTC")
        .set("PAYMENT-SIGNATURE", header);

      expect(res.status).toBe(402);
      expect(res.body.error).toBe("Insufficient payment amount");
    });

    it("rejects replayed voucher with the same nonce (409)", async () => {
      const now = BigInt(Math.floor(Date.now() / 1000) + 60);
      const { header } = signVoucher(
        BigInt(99),
        agentKeypair,
        providerKeypair,
        pricePerRequest,
        now
      );

      // First request succeeds
      const res1 = await request(app)
        .get("/price/BTC")
        .set("PAYMENT-SIGNATURE", header);
      expect(res1.status).toBe(200);

      // Second request with exact same voucher must be rejected
      const res2 = await request(app)
        .get("/price/BTC")
        .set("PAYMENT-SIGNATURE", header);
      expect(res2.status).toBe(409);
      expect(res2.body.error).toBe("Nonce already used");
    });

    it("cleans up expired nonces on sweep", () => {
      const past = Math.floor(Date.now() / 1000) - 10;
      const future = Math.floor(Date.now() / 1000) + 60;
      const testKey1 = "agent1:123";
      const testKey2 = "agent2:456";

      usedNonces.set(testKey1, past);
      usedNonces.set(testKey2, future);

      sweepExpiredNonces();

      expect(usedNonces.has(testKey1)).toBe(false);
      expect(usedNonces.has(testKey2)).toBe(true);

      usedNonces.delete(testKey2);
    });
  });
});
