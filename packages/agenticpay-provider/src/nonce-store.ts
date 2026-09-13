import { NonceStore } from "./types";

/**
 * In-memory TTL nonce store.
 *
 * Suitable for single-process deployments (hackathon demo, devnet, staging).
 * For multi-process / multi-region production, implement {@link NonceStore}
 * against Redis / DynamoDB / Postgres with a unique constraint on `nonce`.
 *
 * The TTL is set from the voucher's `expires_at`, so entries disappear
 * naturally after the voucher can no longer be used. This is the same
 * guarantee the on-chain `NonceReceipt` PDA provides — the on-chain
 * version remains the source of truth; this store is a fast local cache
 * that also protects the resource server from spammy replays.
 */
export class InMemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>(); // nonce → expiresAtMs
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(cleanupIntervalMs: number = 30_000) {
    this.cleanupTimer = setInterval(() => this.sweep(), cleanupIntervalMs);
    // Don't hold the event loop open.
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  has(nonce: bigint): boolean {
    const key = nonce.toString();
    const expiry = this.seen.get(key);
    if (expiry === undefined) return false;
    if (Date.now() >= expiry) {
      this.seen.delete(key);
      return false;
    }
    return true;
  }

  mark(nonce: bigint, expiresAtMs: number): boolean {
    const key = nonce.toString();
    if (this.has(nonce)) return false;
    this.seen.set(key, expiresAtMs);
    return true;
  }

  /** Remove all entries (useful in tests). */
  clear(): void {
    this.seen.clear();
  }

  /** Stop the cleanup timer (useful in tests / graceful shutdown). */
  dispose(): void {
    clearInterval(this.cleanupTimer);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [nonce, expiry] of this.seen.entries()) {
      if (now >= expiry) this.seen.delete(nonce);
    }
  }
}
