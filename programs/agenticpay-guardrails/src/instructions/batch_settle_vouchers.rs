use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};

use crate::contexts::BatchSettleVouchers;
use crate::constants::SLOTS_PER_DAY;
use crate::error::GuardrailError;
use crate::state::VoucherSettled;
use crate::verification::{verify_canonical_message, verify_ed25519_ix};

pub fn handler(
    ctx: Context<BatchSettleVouchers>,
    canonical_message: Vec<u8>,
    provider: Pubkey,
    amount_lamports: u64,
    nonce: u64,
    expires_at: i64,
) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;

    // 1. Pause.
    require!(!escrow.paused, GuardrailError::Paused);

    // 2. Per-tx cap.
    require!(
        amount_lamports <= escrow.per_tx_cap_lamports,
        GuardrailError::PerTxCapExceeded
    );

    // 3. Daily cap with slot-based reset.
    let clock = Clock::get()?;
    if clock.slot.saturating_sub(escrow.last_reset_slot) >= SLOTS_PER_DAY {
        escrow.spent_today_lamports = 0;
        escrow.last_reset_slot = clock.slot;
    }
    require!(
        escrow.spent_today_lamports.saturating_add(amount_lamports)
            <= escrow.daily_cap_lamports,
        GuardrailError::DailyCapExceeded
    );

    // 4. TTL.
    require!(clock.unix_timestamp <= expires_at, GuardrailError::VoucherExpired);

    // ─── Replay protection ────────────────────────────────────────────
    // A receipt with nonce == 0 means "freshly created this instruction".
    // Any other value means the nonce was already consumed.
    require!(
        ctx.accounts.nonce_receipt.nonce == 0,
        GuardrailError::NonceAlreadyUsed
    );
    ctx.accounts.nonce_receipt.nonce = nonce;
    ctx.accounts.nonce_receipt.created_at = clock.unix_timestamp;

    // 5. Ed25519 verification.
    verify_ed25519_ix(
        &ctx.accounts.instructions_sysvar,
        &canonical_message,
        &escrow.agent.to_bytes(),
    )?;

    // 6. Canonical message integrity.
    verify_canonical_message(
        &canonical_message,
        nonce,
        &escrow.agent.to_bytes(),
        &provider.to_bytes(),
        amount_lamports,
        expires_at,
    )?;

    // 7. Update spent counter before CPI to release the mutable borrow.
    escrow.spent_today_lamports = escrow.spent_today_lamports.saturating_add(amount_lamports);

    let escrow_key = escrow.key();
    let escrow_owner = escrow.owner;
    let escrow_bump = escrow.bump;

    // 8. Transfer lamports from escrow PDA to provider.
    let seeds = &[b"escrow", escrow_owner.as_ref(), &[escrow_bump]];
    let signer = &[&seeds[..]];

    let transfer_ix = system_instruction::transfer(&escrow_key, &provider, amount_lamports);
    invoke_signed(
        &transfer_ix,
        &[
            ctx.accounts.escrow.to_account_info(),
            ctx.accounts.provider.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        signer,
    )?;

    emit!(VoucherSettled {
        nonce,
        provider,
        amount_lamports,
        escrow: escrow_key,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}