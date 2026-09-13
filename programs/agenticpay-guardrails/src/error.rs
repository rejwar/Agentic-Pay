use anchor_lang::prelude::*;

#[error_code]
pub enum GuardrailError {
    #[msg("Escrow is paused")]
    Paused,
    #[msg("Amount exceeds per-transaction cap")]
    PerTxCapExceeded,
    #[msg("Amount would exceed daily cap")]
    DailyCapExceeded,
    #[msg("Voucher has expired")]
    VoucherExpired,
    #[msg("Missing or invalid Ed25519 verification instruction")]
    MissingEd25519Instruction,
    #[msg("Ed25519 instruction is malformed")]
    InvalidEd25519Instruction,
    #[msg("Signed message does not match expected canonical bytes")]
    MessageMismatch,
    #[msg("Agent pubkey does not match the escrow's registered agent")]
    AgentPubkeyMismatch,
    #[msg("Nonce has already been consumed")]
    NonceAlreadyUsed,
}