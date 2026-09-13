import { Request, Response, NextFunction } from "express";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  decodeVoucherHeader,
  verifyVoucher,
  isExpired,
  bufferToPubkeyString,
  VoucherPayload,
} from "./voucher";

// Extend Express Request interface to carry decoded voucher
declare global {
  namespace Express {
    interface Request {
      voucher?: VoucherPayload;
      agentPubkey?: string;
    }
  }
}

export interface PaywallConfig {
  providerKeypair: Keypair;
  pricePerRequestLamports: bigint;
  voucherTtlSecs: number;
}

// A tiny TTL-bounded store is enough — nonces only need to be
// remembered until their own voucher would've expired anyway.
export const usedNonces = new Map<string, number>(); // key -> expiresAtSecs

export function nonceKey(agent: Buffer, nonce: bigint): string {
  return `${agent.toString("base64")}:${nonce.toString()}`;
}

export function sweepExpiredNonces() {
  const now = Math.floor(Date.now() / 1000);
  for (const [key, exp] of usedNonces) {
    if (exp < now) usedNonces.delete(key);
  }
}
const sweepInterval = setInterval(sweepExpiredNonces, 30_000);
if (sweepInterval.unref) {
  sweepInterval.unref();
}

/**
 * Initialize provider keypair from environment or generate a default one.
 */
export function getOrCreateProviderKeypair(): Keypair {
  const secretKeyEnv = process.env.PROVIDER_SECRET_KEY;
  if (secretKeyEnv) {
    try {
      const decoded = bs58.decode(secretKeyEnv);
      return Keypair.fromSecretKey(decoded);
    } catch (e) {
      console.warn("[Paywall] Failed to decode PROVIDER_SECRET_KEY from base58, generating ephemeral keypair");
    }
  }
  return Keypair.generate();
}

/**
 * Express middleware creating an x402 paywall.
 */
export function createPaywallMiddleware(config: PaywallConfig) {
  const providerPubkeyBuffer = config.providerKeypair.publicKey.toBuffer();
  const providerPubkeyBase58 = config.providerKeypair.publicKey.toBase58();

  return (req: Request, res: Response, next: NextFunction): void => {
    const signatureHeader = req.header("PAYMENT-SIGNATURE");

    // 1. If no voucher header is present, respond with 402 Payment Required
    if (!signatureHeader) {
      const paymentRequiredInfo = {
        price: Number(config.pricePerRequestLamports),
        network: "solana",
        recipient: providerPubkeyBase58,
        ttl: config.voucherTtlSecs,
        scheme: "agenticpay_x402v1",
      };

      res.setHeader("PAYMENT-REQUIRED", JSON.stringify(paymentRequiredInfo));
      res.status(402).json({
        error: "Payment Required",
        payment_required: paymentRequiredInfo,
      });
      return;
    }

    // 2. Decode the voucher header
    let voucher: VoucherPayload;
    try {
      voucher = decodeVoucherHeader(signatureHeader);
    } catch (err) {
      res.status(400).json({
        error: "Malformed voucher header",
        message: (err as Error).message,
      });
      return;
    }

    // 3. Verify provider matches this server
    if (!voucher.provider.equals(providerPubkeyBuffer)) {
      res.status(400).json({
        error: "Provider mismatch",
        expected: providerPubkeyBase58,
        received: bufferToPubkeyString(voucher.provider),
      });
      return;
    }

    // 4. Verify amount is sufficient
    if (voucher.amountLamports < config.pricePerRequestLamports) {
      res.status(402).json({
        error: "Insufficient payment amount",
        requiredLamports: config.pricePerRequestLamports.toString(),
        providedLamports: voucher.amountLamports.toString(),
      });
      return;
    }

    // 5. Verify voucher has not expired
    if (isExpired(voucher)) {
      res.status(402).json({
        error: "Voucher expired",
        expiresAt: voucher.expiresAt.toString(),
        currentTimestamp: Math.floor(Date.now() / 1000).toString(),
      });
      return;
    }

    // 6. Verify Ed25519 signature
    const isValidSignature = verifyVoucher(voucher);
    if (!isValidSignature) {
      res.status(401).json({
        error: "Invalid voucher signature",
      });
      return;
    }

    // 7. Prevent replay attacks: verify nonce has not been used
    const key = nonceKey(voucher.agent, voucher.nonce);
    if (usedNonces.has(key)) {
      res.status(409).json({ error: "Nonce already used" });
      return;
    }
    usedNonces.set(key, Number(voucher.expiresAt));

    // 8. Payment verified: attach voucher to request and proceed
    req.voucher = voucher;
    req.agentPubkey = bufferToPubkeyString(voucher.agent);
    next();
  };
}
