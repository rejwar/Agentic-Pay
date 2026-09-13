import { PublicKey } from "@solana/web3.js";
import * as nacl from "tweetnacl";
import { AgenticPayError } from "./types";

/**
 * Canonical message layout (105 bytes) — MUST match the Rust `voucher.rs`
 * and the Anchor `verification.rs` byte-for-byte.
 *
 *   0..17  : domain separator "agenticpay_x402v1"
 *  17..25  : nonce (u64 LE)
 *  25..57  : agent pubkey (32 bytes, raw)
 *  57..89  : provider pubkey (32 bytes, raw)
 *  89..97  : amount_lamports (u64 LE)
 *  97..105 : expires_at (i64 LE)
 */
export const CANONICAL_LEN = 105;
export const SIGNATURE_LEN = 64;
export const RETRY_COUNT_LEN = 1;
export const WIRE_LEN = CANONICAL_LEN + SIGNATURE_LEN + RETRY_COUNT_LEN; // 170

export interface ParsedVoucher {
  domainSeparator: Buffer;
  nonce: bigint;
  agent: PublicKey;
  provider: PublicKey;
  amountLamports: bigint;
  expiresAt: bigint;
  signature: Uint8Array;
  retryCount: number;
  /** The raw 105-byte canonical message (needed for Ed25519 verification). */
  canonical: Buffer;
}

/**
 * Decode a Base64 `PAYMENT-SIGNATURE` header value into a structured voucher.
 * Rejects malformed payloads early so the caller never touches unverified bytes.
 */
export function decodeVoucherPayload(encoded: string): ParsedVoucher {
  let raw: Buffer;
  try {
    raw = Buffer.from(encoded, "base64");
  } catch {
    throw new AgenticPayError("VOUCHER_MALFORMED", "Invalid Base64");
  }

  if (raw.length !== WIRE_LEN) {
    throw new AgenticPayError(
      "VOUCHER_MALFORMED",
      `Expected ${WIRE_LEN} bytes, got ${raw.length}`,
    );
  }

  const canonical = raw.subarray(0, CANONICAL_LEN);
  const signature = raw.subarray(CANONICAL_LEN, CANONICAL_LEN + SIGNATURE_LEN);
  const retryCount = raw[CANONICAL_LEN + SIGNATURE_LEN];

  const domainSeparator = canonical.subarray(0, 17);
  const nonce = canonical.readBigUInt64LE(17);
  const agentBytes = canonical.subarray(25, 57);
  const providerBytes = canonical.subarray(57, 89);
  const amountLamports = canonical.readBigUInt64LE(89);
  const expiresAt = canonical.readBigInt64LE(97);

  return {
    domainSeparator,
    nonce,
    agent: new PublicKey(agentBytes),
    provider: new PublicKey(providerBytes),
    amountLamports,
    expiresAt,
    signature,
    retryCount,
    canonical,
  };
}

/**
 * Verify the Ed25519 signature over the canonical message.
 * The public key is the voucher's `agent` field (self-certifying).
 */
export function verifyVoucherSignature(voucher: ParsedVoucher): void {
  const ok = nacl.sign.detached.verify(
    voucher.canonical,
    voucher.signature,
    voucher.agent.toBytes(),
  );
  if (!ok) {
    throw new AgenticPayError("VOUCHER_BAD_SIGNATURE", "Ed25519 verification failed");
  }
}
