import { expect } from "chai";
import express from "express";
import request from "supertest";
import { Keypair } from "@solana/web3.js";
import * as nacl from "tweetnacl";
import {
  agenticPay,
  InMemoryNonceStore,
  WIRE_LEN,
} from "../src";

const DOMAIN = "agenticpay_x402v1";

function buildVoucher(opts: {
  agent: Keypair;
  provider: Uint8Array;
  nonce: bigint;
  amountLamports: bigint;
  expiresAt: bigint;
}): string {
  const canonical = Buffer.alloc(105);
  Buffer.from(DOMAIN, "utf8").copy(canonical, 0);
  canonical.writeBigUInt64LE(opts.nonce, 17);
  Buffer.from(opts.agent.publicKey.toBytes()).copy(canonical, 25);
  Buffer.from(opts.provider).copy(canonical, 57);
  canonical.writeBigUInt64LE(opts.amountLamports, 89);
  canonical.writeBigInt64LE(opts.expiresAt, 97);

  const sig = nacl.sign.detached(canonical, opts.agent.secretKey);
  const wire = Buffer.concat([canonical, Buffer.from(sig), Buffer.from([0])]);
  if (wire.length !== WIRE_LEN) throw new Error("wire length mismatch");
  return wire.toString("base64");
}

function buildApp(config: Parameters<typeof agenticPay>[0]) {
  const app = express();
  app.get("/price", agenticPay(config), (req, res) => {
    res.json({ ok: true, agenticPay: (req as any).agenticPay?.nonce?.toString() });
  });
  return app;
}

describe("@agenticpay/provider — middleware", () => {
  const providerKeypair = Keypair.generate();
  const provider = providerKeypair.publicKey;
  const price = 1_000n;
  const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

  it("returns 402 with terms when no PAYMENT-SIGNATURE header is present", async () => {
    const app = buildApp({ provider, price });
    const res = await request(app).get("/price");
    expect(res.status).to.equal(402);
    expect(res.body.error).to.equal("Payment Required");
    expect(res.body.payment_required.recipient).to.equal(provider.toBase58());
    expect(res.body.payment_required.price).to.equal(1000);
    expect(res.body.payment_required.scheme).to.equal("agenticpay_x402v1");
    expect(res.headers["payment-required"]).to.be.a("string");
  });

  it("accepts a valid voucher and attaches it to the request", async () => {
    const agent = Keypair.generate();
    const app = buildApp({ provider, price });
    const voucher = buildVoucher({
      agent,
      provider: provider.toBytes(),
      nonce: 42n,
      amountLamports: price,
      expiresAt: nowSec() + 60n,
    });
    const res = await request(app).get("/price").set("PAYMENT-SIGNATURE", voucher);
    expect(res.status).to.equal(200);
    expect(res.body.ok).to.equal(true);
    expect(res.body.agenticPay).to.equal("42");
  });

  it("rejects a replayed nonce (NONCE_REPLAY)", async () => {
    const agent = Keypair.generate();
    const store = new InMemoryNonceStore();
    const app = buildApp({ provider, price, nonceStore: store });
    const voucher = buildVoucher({
      agent,
      provider: provider.toBytes(),
      nonce: 99n,
      amountLamports: price,
      expiresAt: nowSec() + 60n,
    });

    const first = await request(app).get("/price").set("PAYMENT-SIGNATURE", voucher);
    expect(first.status).to.equal(200);

    const second = await request(app).get("/price").set("PAYMENT-SIGNATURE", voucher);
    expect(second.status).to.equal(402);
    expect(second.body.code).to.equal("NONCE_REPLAY");
  });

  it("rejects an expired voucher", async () => {
    const agent = Keypair.generate();
    const app = buildApp({ provider, price });
    const voucher = buildVoucher({
      agent,
      provider: provider.toBytes(),
      nonce: 1n,
      amountLamports: price,
      expiresAt: nowSec() - 1n,
    });
    const res = await request(app).get("/price").set("PAYMENT-SIGNATURE", voucher);
    expect(res.status).to.equal(402);
    expect(res.body.code).to.equal("VOUCHER_EXPIRED");
  });

  it("rejects a voucher addressed to a different provider", async () => {
    const agent = Keypair.generate();
    const otherProvider = Keypair.generate();
    const app = buildApp({ provider, price });
    const voucher = buildVoucher({
      agent,
      provider: otherProvider.publicKey.toBytes(),
      nonce: 7n,
      amountLamports: price,
      expiresAt: nowSec() + 60n,
    });
    const res = await request(app).get("/price").set("PAYMENT-SIGNATURE", voucher);
    expect(res.status).to.equal(402);
    expect(res.body.code).to.equal("VOUCHER_WRONG_PROVIDER");
  });

  it("rejects a voucher with insufficient amount", async () => {
    const agent = Keypair.generate();
    const app = buildApp({ provider, price });
    const voucher = buildVoucher({
      agent,
      provider: provider.toBytes(),
      nonce: 11n,
      amountLamports: price - 1n,
      expiresAt: nowSec() + 60n,
    });
    const res = await request(app).get("/price").set("PAYMENT-SIGNATURE", voucher);
    expect(res.status).to.equal(402);
    expect(res.body.code).to.equal("VOUCHER_INSUFFICIENT");
  });

  it("rejects a voucher with a tampered signature", async () => {
    const agent = Keypair.generate();
    const app = buildApp({ provider, price });
    const valid = buildVoucher({
      agent,
      provider: provider.toBytes(),
      nonce: 21n,
      amountLamports: price,
      expiresAt: nowSec() + 60n,
    });
    // Flip a bit in the signature region.
    const bytes = Buffer.from(valid, "base64");
    bytes[120] ^= 0xff;
    const tampered = bytes.toString("base64");

    const res = await request(app).get("/price").set("PAYMENT-SIGNATURE", tampered);
    expect(res.status).to.equal(402);
    expect(res.body.code).to.equal("VOUCHER_BAD_SIGNATURE");
  });

  it("rejects a malformed payload", async () => {
    const app = buildApp({ provider, price });
    const res = await request(app).get("/price").set("PAYMENT-SIGNATURE", "not-base64!!");
    expect(res.status).to.equal(402);
    expect(res.body.code).to.equal("VOUCHER_MALFORMED");
  });

  it("fires onVerified on success only", async () => {
    const agent = Keypair.generate();
    const seen: bigint[] = [];
    const app = buildApp({
      provider,
      price,
      onVerified: (v) => seen.push(v.nonce),
    });
    const voucher = buildVoucher({
      agent,
      provider: provider.toBytes(),
      nonce: 555n,
      amountLamports: price,
      expiresAt: nowSec() + 60n,
    });
    await request(app).get("/price").set("PAYMENT-SIGNATURE", voucher);
    expect(seen).to.deep.equal([555n]);
  });
});
