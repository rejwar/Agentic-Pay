use anchor_lang::prelude::*;

#[account]
pub struct Escrow {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub daily_cap_lamports: u64,
    pub per_tx_cap_lamports: u64,
    pub spent_today_lamports: u64,
    pub last_reset_slot: u64,
    pub paused: bool,
    pub bump: u8,
}

impl Escrow {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1;
}

#[account]
pub struct SessionKey {
    pub escrow: Pubkey,
    pub session_key: Pubkey,
    pub per_tx_limit: u64,
    pub expires_at: i64,
    pub bump: u8,
}

impl SessionKey {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 1;
}

#[account]
pub struct NonceReceipt {
    /// The nonce this receipt was created for.
    pub nonce: u64,
    /// Unix timestamp when the receipt was created.
    pub created_at: i64,
}

impl NonceReceipt {
    pub const LEN: usize = 8 + 8; // discriminator + nonce + created_at
}

#[event]
pub struct VoucherSettled {
    pub nonce: u64,
    pub provider: Pubkey,
    pub amount_lamports: u64,
    pub escrow: Pubkey,
    pub timestamp: i64,
}