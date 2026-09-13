import type { Request, Response, NextFunction, RequestHandler } from "express";
import { AgenticPayConfig, AgenticPayError, VerifiedVoucher } from "./types";
import { decodeVoucherPayload, verifyVoucherSignature } from "./voucher";
import { InMemoryNonceStore } from "./nonce-store";

/**
 * Express middleware factory. Returns a `RequestHandler` that:
 *
 *   1. If `PAYMENT-SIGNATURE` is missing → responds 402 with the payment terms.
 *   2. Otherwise → decodes the voucher, verifies signature, checks nonce,
 *      checks amount, and calls `next()` on success. Attaches the verified
 *      voucher to `req.agenticPay` for downstream handlers.
 *
 * The middleware never touches the chain — all checks are local. The
 * provider decides how to periodically reconcile with on-chain settlement.
 */
export function agenticPay(config: AgenticPayConfig): RequestHandler {
  if (!config.provider) throw new Error("agenticPay: `provider` is required");
  if (config.price <= 0n) throw new Error("agenticPay: `price` must be positive");

  const ttlSeconds = config.ttlSeconds ?? 60;
  const network = config.network ?? "solana";
  const scheme = config.scheme ?? "agenticpay_x402v1";
  const nonceStore = config.nonceStore ?? new InMemoryNonceStore();

  return function agenticPayMiddleware(req: Request, res: Response, next: NextFunction) {
    const headerValue = req.header("payment-signature") ?? req.header("PAYMENT-SIGNATURE");

    // ── No payment attached → advertise terms ─────────────────────────────
    if (!headerValue) {
      const terms = {
        price: Number(config.price),
        network,
        recipient: config.provider.toBase58(),
        ttl: ttlSeconds,
        scheme,
      };
      res.setHeader("PAYMENT-REQUIRED", JSON.stringify(terms));
      return res.status(402).json({
        error: "Payment Required",
        payment_required: terms,
      });
    }

    // ── Payment attached → verify ─────────────────────────────────────────
    try {
      const voucher = decodeVoucherPayload(headerValue);

      // 1. Domain separator (fast reject on cross-protocol replay)
      const expectedDomain = Buffer.from(scheme, "utf8");
      if (!voucher.domainSeparator.equals(expectedDomain)) {
        throw new AgenticPayError(
          "VOUCHER_MALFORMED",
          `Unexpected domain separator: ${voucher.domainSeparator.toString("utf8")}`,
        );
      }

      // 2. Provider match
      if (!voucher.provider.equals(config.provider)) {
        throw new AgenticPayError(
          "VOUCHER_WRONG_PROVIDER",
          `Voucher addressed to ${voucher.provider.toBase58()}, this server is ${config.provider.toBase58()}`,
        );
      }

      // 3. Amount sufficiency
      if (voucher.amountLamports < config.price) {
        throw new AgenticPayError(
          "VOUCHER_INSUFFICIENT",
          `Voucher amount ${voucher.amountLamports} < required ${config.price}`,
        );
      }

      // 4. TTL
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      if (voucher.expiresAt <= nowSec) {
        throw new AgenticPayError(
          "VOUCHER_EXPIRED",
          `Voucher expired at ${voucher.expiresAt}, now ${nowSec}`,
        );
      }

      // 5. Ed25519 signature (the expensive step — do it after cheap checks)
      verifyVoucherSignature(voucher);

      // 6. Nonce replay protection
      const expiresAtMs = Number(voucher.expiresAt) * 1000;
      const inserted = nonceStore.mark(voucher.nonce, expiresAtMs);
      if (!inserted) {
        throw new AgenticPayError(
          "NONCE_REPLAY",
          `Nonce ${voucher.nonce} already consumed`,
        );
      }

      // ── Verified ────────────────────────────────────────────────────────
      const verified: VerifiedVoucher = {
        nonce: voucher.nonce,
        agent: voucher.agent,
        provider: voucher.provider,
        amountLamports: voucher.amountLamports,
        expiresAt: voucher.expiresAt,
        signature: voucher.signature,
        receivedAt: Date.now(),
      };

      // Attach for downstream handlers.
      (req as Request & { agenticPay?: VerifiedVoucher }).agenticPay = verified;

      // Fire the optional callback (async-safe — errors don't block the request).
      if (config.onVerified) {
        try {
          config.onVerified(verified);
        } catch (e) {
          // Log-only — a metrics hook must never break fulfilment.
          console.error("[agenticPay] onVerified callback threw:", e);
        }
      }

      return next();
    } catch (err) {
      const apiErr =
        err instanceof AgenticPayError
          ? err
          : new AgenticPayError(
              "INTERNAL_ERROR",
              err instanceof Error ? err.message : String(err),
              500,
            );

      if (config.onError) {
        return config.onError(apiErr, res);
      }

      return res.status(apiErr.httpStatus).json({
        error: apiErr.message,
        code: apiErr.code,
      });
    }
  };
}
