export { agenticPay } from "./middleware";
export { InMemoryNonceStore } from "./nonce-store";
export {
  decodeVoucherPayload,
  verifyVoucherSignature,
  CANONICAL_LEN,
  SIGNATURE_LEN,
  WIRE_LEN,
  type ParsedVoucher,
} from "./voucher";
export {
  AgenticPayError,
  type AgenticPayConfig,
  type AgenticPayErrorCode,
  type NonceStore,
  type VerifiedVoucher,
} from "./types";

// Express Request augmentation (consumers get `req.agenticPay` typed).
declare global {
  namespace Express {
    interface Request {
      agenticPay?: import("./types").VerifiedVoucher;
    }
  }
}
