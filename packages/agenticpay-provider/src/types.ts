import { PublicKey } from "@solana/web3.js";

/**
 * Configuration for the AgenticPay paywall middleware.
 */
export interface AgenticPayConfig {
  /** Recipient Solana pubkey (where settled lamports are sent). */
  provider: PublicKey;

  /** Price per request, in lamports. */
  price: bigint;

  /** Voucher TTL (seconds). Advertised in the 402 response. Default: 60. */
  ttlSeconds?: number;

  /** Solana network name (advertised only, no RPC calls made). Default: "solana". */
  network?: string;

  /**
   * Scheme identifier. Must match the on-chain domain separator.
   * Default: "agenticpay_x402v1".
   */
  scheme?: string;

  /**
   * Nonce store for replay protection.
   * Default: in-memory TTL store (survives for the process lifetime).
   * For multi-process deployments, provide a Redis-backed implementation.
   */
  nonceStore?: NonceStore;

  /**
   * Optional callback fired after a voucher is fully verified (signature + nonce + amount).
   * Useful for logging, metrics, or settlement queueing.
   */
  onVerified?: (voucher: VerifiedVoucher) => void;

  /**
   * Optional custom error handler. If omitted, failures return a 402 JSON response.
   * The error type is one of the {@link AgenticPayErrorCode} values.
   */
  onError?: (err: AgenticPayError, res: any) => void;
}

/**
 * A voucher that has passed all verifications.
 */
export interface VerifiedVoucher {
  nonce: bigint;
  agent: PublicKey;
  provider: PublicKey;
  amountLamports: bigint;
  expiresAt: bigint;
  signature: Uint8Array;
  /** Wall-clock time (Unix ms) when the middleware accepted this voucher. */
  receivedAt: number;
}

/**
 * Pluggable nonce store.
 *
 * Implementations must be atomic under concurrency: `mark()` should return
 * false if the nonce was already present, or throw on I/O failure.
 */
export interface NonceStore {
  /**
   * Returns true if the nonce is already consumed.
   * Must be cheap (fast lookup).
   */
  has(nonce: bigint): boolean | Promise<boolean>;

  /**
   * Atomically record a nonce as consumed, expiring at `expiresAtMs`
   * (Unix ms). Returns true if the record was newly created, false if it
   * already existed (indicating a replay race).
   */
  mark(nonce: bigint, expiresAtMs: number): boolean | Promise<boolean>;
}

/**
 * Error codes returned by the middleware.
 * The client should match on these, not on human-readable strings.
 */
export type AgenticPayErrorCode =
  | "PAYMENT_REQUIRED"        // 402 emitted without a voucher
  | "VOUCHER_MALFORMED"       // Base64 decode or length mismatch
  | "VOUCHER_EXPIRED"         // expires_at <= now
  | "VOUCHER_WRONG_PROVIDER"  // voucher.provider != config.provider
  | "VOUCHER_INSUFFICIENT"    // voucher.amount < config.price
  | "VOUCHER_BAD_SIGNATURE"   // Ed25519 verification failed
  | "NONCE_REPLAY"            // nonce already consumed
  | "INTERNAL_ERROR";         // unexpected

export class AgenticPayError extends Error {
  constructor(
    public readonly code: AgenticPayErrorCode,
    message: string,
    public readonly httpStatus: number = 402,
  ) {
    super(message);
    this.name = "AgenticPayError";
  }
}
