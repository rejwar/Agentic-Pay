//! Deferred settlement worker: batches and settles vouchers on Solana
//! by calling the `agenticpay-guardrails` Anchor program.

use crate::error::EngineError;
use crate::solana_rpc::{AsyncSolanaProvider, SolanaRpcAdapter};
use crate::state::{NoncePhase, ServerState};
use crate::voucher::{VoucherCryptography, VoucherPayload};

use borsh::BorshSerialize;
use solana_sdk::{
    ed25519_instruction::new_ed25519_instruction_with_signature,
    hash::Hash,
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    message::{v0, VersionedMessage},
    pubkey::Pubkey,
    signature::{Keypair, Signature, Signer},
    sysvar::instructions::ID as INSTRUCTIONS_SYSVAR_ID,
    transaction::VersionedTransaction,
};
use solana_system_interface::program as system_program;
use std::sync::Arc;
use std::time::Duration;
use tokio::time;
use tracing::{error, info, warn};

/// Default guardrails program ID (matches `declare_id!` in the Anchor program).
pub const DEFAULT_GUARDRAILS_PROGRAM_ID: &str =
    "Grd1111111111111111111111111111111111111111";

/// Anchor discriminator for `batch_settle_vouchers`.
/// Computed as sha256("global:batch_settle_vouchers")[..8].
pub const BATCH_SETTLE_VOUCHERS_DISCRIMINATOR: [u8; 8] =
    [24, 217, 119, 6, 222, 175, 228, 200];

/// Base overhead for a transaction (signatures, blockhash, headers, ALT lookups).
const BASE_TX_OVERHEAD: usize = 300;

/// Marginal cost per voucher in a transaction:
/// - Ed25519 instruction: ~217 bytes (16 header + 32 pk + 64 sig + 105 msg)
/// - Anchor settle instruction: ~173 bytes (8 disc + 4 len + 105 msg + 32 provider + 8 amount + 8 nonce + 8 expires)
/// - Account meta framing: ~50 bytes
const MARGINAL_COST_PER_VOUCHER: usize = 440;

/// Maximum transaction size (MTU).
const MAX_TX_SIZE: usize = 1232;

// ---------- Configuration ----------

#[derive(Clone)]
pub struct WorkerConfig {
    pub batch_interval: Duration,
    pub max_retries: usize,
    pub retry_backoff_base: Duration,
    /// Program ID of the on-chain guardrails.
    pub program_id: Pubkey,
    /// Escrow owner (used to derive the escrow PDA).
    /// If `Pubkey::default()`, falls back to the voucher's agent pubkey.
    pub escrow_owner: Pubkey,
    /// Optional fee payer. If `None`, uses the agent's keypair pubkey or `batch[0].agent`.
    pub fee_payer: Option<Pubkey>,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            batch_interval: Duration::from_secs(10),
            max_retries: 3,
            retry_backoff_base: Duration::from_secs(2),
            program_id: Pubkey::from_str_const(DEFAULT_GUARDRAILS_PROGRAM_ID),
            escrow_owner: Pubkey::default(),
            fee_payer: None,
        }
    }
}

// ---------- Settlement Worker ----------

pub struct SettlementWorker {
    pub state: Arc<ServerState>,
    pub rpc: Arc<AsyncSolanaProvider>,
    pub config: WorkerConfig,
    /// Agent's signing keypair for transaction signing.
    pub agent_keypair: Arc<Keypair>,
}

impl SettlementWorker {
    pub fn new(
        state: Arc<ServerState>,
        rpc: Arc<AsyncSolanaProvider>,
        config: WorkerConfig,
        agent_keypair: Arc<Keypair>,
    ) -> Self {
        Self {
            state,
            rpc,
            config,
            agent_keypair,
        }
    }

    /// Start the worker loop.
    pub async fn run(&self) {
        let mut interval = time::interval(self.config.batch_interval);
        loop {
            interval.tick().await;
            if let Err(e) = self.process_cycle().await {
                error!("Worker cycle error: {}", e);
            }
        }
    }

    pub async fn process_cycle(&self) -> Result<(), EngineError> {
        let vouchers = self.state.extract_and_lock_intent_vouchers();
        if vouchers.is_empty() {
            return Ok(());
        }

        info!("Extracted and locked {} vouchers for settlement", vouchers.len());

        let chunks = Self::chunk_vouchers(&vouchers);
        for chunk in chunks {
            if let Err(e) = self.settle_batch(chunk).await {
                error!("Batch settlement failed: {}", e);
            }
        }
        Ok(())
    }

    // ---------- MTU-Aware Chunking ----------

    pub fn chunk_vouchers(vouchers: &[VoucherPayload]) -> Vec<Vec<VoucherPayload>> {
        let mut chunks = Vec::new();
        let mut current = Vec::new();
        let mut projected_size = BASE_TX_OVERHEAD;

        for v in vouchers {
            let new_size = projected_size + MARGINAL_COST_PER_VOUCHER;
            if new_size > MAX_TX_SIZE {
                if !current.is_empty() {
                    chunks.push(std::mem::take(&mut current));
                }
                projected_size = BASE_TX_OVERHEAD;
            }
            current.push(v.clone());
            projected_size += MARGINAL_COST_PER_VOUCHER;
        }
        if !current.is_empty() {
            chunks.push(current);
        }
        chunks
    }

    // ---------- Settlement ----------

    pub async fn settle_batch(&self, batch: Vec<VoucherPayload>) -> Result<(), EngineError> {
        if batch.is_empty() {
            return Ok(());
        }

        // 1. Build the transaction.
        let tx = self.build_batch_transaction(&batch)?;

        // 2. Serialize and send.
        let tx_bytes = bincode::serialize(&tx)
            .map_err(|_| EngineError::PayloadFormatInvalid)?;

        match self.rpc.send_transaction(&tx_bytes).await {
            Ok(sig) => {
                info!("Batch settled: {}", hex::encode(sig));
                for v in &batch {
                    if let Err(e) = self.state.promote_phase_sync(v.nonce, NoncePhase::Finalized) {
                        error!("Failed to promote nonce {}: {}", v.nonce, e);
                    }
                }
                Ok(())
            }
            Err(e) => {
                warn!("Batch submission failed: {}", e);
                for mut v in batch {
                    v.retry_count = v.retry_count.saturating_add(1);
                    if (v.retry_count as usize) < self.config.max_retries {
                        if let Err(err) = self.state.promote_phase_with_voucher_sync(
                            v.nonce,
                            NoncePhase::IntentSigned(v.signature),
                            v.clone(),
                        ) {
                            error!("Failed to revert nonce {}: {}", v.nonce, err);
                        }
                    } else {
                        if let Err(err) = self.state.mark_voucher_failed(v.nonce, &v.agent) {
                            error!("Failed to mark nonce {} as failed: {}", v.nonce, err);
                        }
                    }
                }
                Err(EngineError::ProviderFault(format!("Batch failed: {}", e)))
            }
        }
    }

    // ---------- Transaction Construction ----------

    pub fn build_batch_transaction(
        &self,
        batch: &[VoucherPayload],
    ) -> Result<VersionedTransaction, EngineError> {
        if batch.is_empty() {
            return Err(EngineError::PayloadFormatInvalid);
        }

        // Determine fee payer.
        let fee_payer = self
            .config
            .fee_payer
            .unwrap_or_else(|| self.agent_keypair.pubkey());

        // Determine escrow owner (for PDA derivation).
        let escrow_owner = if self.config.escrow_owner == Pubkey::default() {
            VoucherPayload::pubkey_from_bytes(&batch[0].agent)
        } else {
            self.config.escrow_owner
        };

        // Derive the escrow PDA.
        let (escrow_pda, _bump) = Pubkey::find_program_address(
            &[b"escrow", escrow_owner.as_ref()],
            &self.config.program_id,
        );

        // Build the instruction list: [ed25519_0, settle_0, ed25519_1, settle_1, ...]
        let mut instructions: Vec<SolanaInstruction> = Vec::with_capacity(batch.len() * 2);

        for voucher in batch {
            let canonical = voucher.canonical_bytes();

            // 1. Ed25519 verification instruction.
            let ed25519_ix = new_ed25519_instruction_with_signature(
                &canonical,
                &voucher.signature,
                &voucher.agent,
            );
            instructions.push(ed25519_ix);

            // 2. Anchor `batch_settle_vouchers` instruction.
            let agent_pubkey = VoucherPayload::pubkey_from_bytes(&voucher.agent);
            let settle_ix = build_batch_settle_instruction(
                &self.config.program_id,
                &escrow_pda,
                &agent_pubkey,
                &voucher.provider,
                voucher,
                &canonical,
            );
            instructions.push(settle_ix);
        }

        // Build a v0 message with the instructions.
        let message = v0::Message::try_compile(
            &fee_payer,
            &instructions,
            &[], // ALT account keys (empty for now)
            Hash::default(),
        )
        .map_err(|e| EngineError::ProviderFault(format!("Message compile failed: {}", e)))?;

        let versioned_message = VersionedMessage::V0(message);
        let mut tx = VersionedTransaction {
            signatures: vec![Signature::default(); 1], // placeholder for fee payer
            message: versioned_message,
        };

        // Sign with the agent keypair if fee payer matches.
        if fee_payer == self.agent_keypair.pubkey() {
            tx.signatures[0] = self.agent_keypair.sign_message(&tx.message.serialize());
        } else {
            return Err(EngineError::ProviderFault(
                "Fee payer must be the agent keypair (multi-signer not yet supported)".into(),
            ));
        }

        Ok(tx)
    }
}

// ---------- Instruction Builders ----------

/// Build an Ed25519 verification instruction using the SDK helper.
///
/// The Solana SDK's `new_ed25519_instruction_with_signature` produces the
/// canonical layout that `sysvar::instructions` expects.
pub fn build_ed25519_instruction(
    agent: &[u8; 32],
    signature: &[u8; 64],
    canonical_message: &[u8],
) -> SolanaInstruction {
    new_ed25519_instruction_with_signature(canonical_message, signature, agent)
}

/// Build the Anchor `batch_settle_vouchers` instruction.
///
/// Build the Anchor `batch_settle_vouchers` instruction.
///
/// Accounts expected by Anchor:
///   0. escrow (mut, PDA)
///   1. nonce_receipt (mut, PDA)
///   2. provider (mut)
///   3. instructions_sysvar (readonly)
///   4. payer (signer, mut)  ← must be agent
///   5. system_program (readonly)
pub fn build_batch_settle_instruction(
    program_id: &Pubkey,
    escrow_pda: &Pubkey,
    agent_pubkey: &Pubkey,
    provider: &[u8; 32],
    voucher: &VoucherPayload,
    canonical_message: &[u8],
) -> SolanaInstruction {
    let mut data = Vec::with_capacity(8 + 4 + canonical_message.len() + 32 + 8 + 8 + 8);

    // 1. Discriminator.
    data.extend_from_slice(&BATCH_SETTLE_VOUCHERS_DISCRIMINATOR);

    // 2. Borsh-serialize the arguments.
    let canonical_vec: Vec<u8> = canonical_message.to_vec();
    canonical_vec
        .serialize(&mut data)
        .expect("Vec<u8> serialization cannot fail");

    let provider_pubkey = Pubkey::new_from_array(*provider);
    provider_pubkey
        .serialize(&mut data)
        .expect("Pubkey serialization cannot fail");

    voucher.amount_lamports
        .serialize(&mut data)
        .expect("u64 serialization cannot fail");

    voucher.nonce
        .serialize(&mut data)
        .expect("u64 serialization cannot fail");

    voucher.expires_at
        .serialize(&mut data)
        .expect("i64 serialization cannot fail");

    // Derive nonce receipt PDA: [b"nonce", escrow.key(), nonce.to_le_bytes()]
    let (nonce_receipt_pda, _bump) = Pubkey::find_program_address(
        &[b"nonce", escrow_pda.as_ref(), &voucher.nonce.to_le_bytes()],
        program_id,
    );

    // Account order MUST match the anchor context:
    // 1. escrow (writable, PDA)
    // 2. nonce_receipt (writable, PDA)
    // 3. provider (writable)
    // 4. instructions_sysvar (readonly)
    // 5. payer (signer, writable)  ← must be agent
    // 6. system_program (readonly)
    let accounts = vec![
        AccountMeta::new(*escrow_pda, false),
        AccountMeta::new(nonce_receipt_pda, false),
        AccountMeta::new(provider_pubkey, false),
        AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR_ID, false),
        AccountMeta::new(*agent_pubkey, true),
        AccountMeta::new_readonly(system_program::id(), false),
    ];

    SolanaInstruction {
        program_id: *program_id,
        accounts,
        data,
    }
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::EngineConfig;

    fn make_voucher(nonce: u64, retry_count: u8) -> VoucherPayload {
        VoucherPayload {
            nonce,
            agent: [1u8; 32],
            provider: [2u8; 32],
            amount_lamports: 1_000_000,
            expires_at: 9_999_999_999,
            signature: [3u8; 64],
            retry_count,
        }
    }

    #[test]
    fn test_chunking_respects_mtu() {
        let vouchers: Vec<_> = (0..10).map(|i| make_voucher(i, 0)).collect();
        let chunks = SettlementWorker::chunk_vouchers(&vouchers);
        for chunk in &chunks {
            let projected = BASE_TX_OVERHEAD + chunk.len() * MARGINAL_COST_PER_VOUCHER;
            assert!(
                projected <= MAX_TX_SIZE,
                "Chunk size {} exceeds MTU {}",
                projected,
                MAX_TX_SIZE
            );
        }
        let total: usize = chunks.iter().map(|c| c.len()).sum();
        assert_eq!(total, 10);
    }

    #[test]
    fn test_discriminator_is_correct() {
        assert_eq!(BATCH_SETTLE_VOUCHERS_DISCRIMINATOR.len(), 8);
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(b"global:batch_settle_vouchers");
        let result = hasher.finalize();
        assert_eq!(&result[..8], &BATCH_SETTLE_VOUCHERS_DISCRIMINATOR);
    }

    #[test]
    fn test_batch_settle_instruction_data_layout() {
        let provider = [7u8; 32];
        let voucher = make_voucher(42, 0);
        let canonical = voucher.canonical_bytes();

        let program_id = Pubkey::new_unique();
        let escrow_pda = Pubkey::new_unique();
        let payer = Pubkey::new_unique();

        let ix = build_batch_settle_instruction(
            &program_id,
            &escrow_pda,
            &payer,
            &provider,
            &voucher,
            &canonical,
        );

        // Check discriminator.
        assert_eq!(&ix.data[0..8], &BATCH_SETTLE_VOUCHERS_DISCRIMINATOR);
        // Check provider bytes at offset 8 + 4 + 105 = 117.
        let provider_offset = 8 + 4 + canonical.len();
        assert_eq!(&ix.data[provider_offset..provider_offset + 32], &provider);
        // Check amount at offset 149.
        let amount_offset = provider_offset + 32;
        let amount_bytes = u64::from_le_bytes(
            ix.data[amount_offset..amount_offset + 8].try_into().unwrap(),
        );
        assert_eq!(amount_bytes, voucher.amount_lamports);
        // Check accounts.
        assert_eq!(ix.accounts.len(), 6);
        assert_eq!(ix.accounts[0].pubkey, escrow_pda);
        let (nonce_receipt_pda, _) = Pubkey::find_program_address(
            &[b"nonce", escrow_pda.as_ref(), &voucher.nonce.to_le_bytes()],
            &program_id,
        );
        assert_eq!(ix.accounts[1].pubkey, nonce_receipt_pda);
        assert_eq!(ix.accounts[2].pubkey, Pubkey::new_from_array(provider));
        assert_eq!(ix.accounts[3].pubkey, INSTRUCTIONS_SYSVAR_ID);
        assert_eq!(ix.accounts[4].pubkey, payer);
        assert_eq!(ix.accounts[5].pubkey, system_program::id());
    }

    #[test]
    fn test_instruction_pairing() {
        let vouchers = vec![make_voucher(1, 0), make_voucher(2, 0)];
        let agent_keypair = Keypair::new();
        let state = Arc::new(ServerState::new(None));
        let rpc = Arc::new(AsyncSolanaProvider::new(
            Arc::new(solana_client::nonblocking::rpc_client::RpcClient::new(
                "http://localhost:8899".to_string(),
            )),
            Duration::from_secs(10),
        ));
        let worker = SettlementWorker::new(
            state,
            rpc,
            WorkerConfig::default(),
            Arc::new(agent_keypair),
        );

        let tx = worker.build_batch_transaction(&vouchers).unwrap();
        // Transaction should contain v0 message
        match tx.message {
            VersionedMessage::V0(msg) => {
                // 2 vouchers * 2 instructions each = 4 instructions
                assert_eq!(msg.instructions.len(), 4);
            }
            _ => panic!("Expected v0 message"),
        }
    }

    #[tokio::test]
    async fn test_extraction_lock_prevents_duplicate_sweep() {
        let state = Arc::new(ServerState::new(Some(EngineConfig::default())));
        let agent = [1u8; 32];
        let provider = [2u8; 32];
        let sig = [3u8; 64];

        let mut voucher = VoucherPayload::new(1001, agent, provider, 50_000, 60);
        voucher.signature = sig;

        let guard = state.try_acquire_nonce_sync(agent, 1001).unwrap();
        guard.commit_with_voucher(NoncePhase::IntentSigned(sig), voucher.clone()).unwrap();

        assert_eq!(
            state.pending_locks.get(&1001).unwrap().state,
            NoncePhase::IntentSigned(sig)
        );

        let swept = state.extract_and_lock_intent_vouchers();
        assert_eq!(swept.len(), 1);
        assert_eq!(swept[0].nonce, 1001);
        assert_eq!(swept[0].retry_count, 0);

        assert_eq!(
            state.pending_locks.get(&1001).unwrap().state,
            NoncePhase::BatchedForSettlement
        );

        let swept_again = state.extract_and_lock_intent_vouchers();
        assert!(swept_again.is_empty());
    }

    #[tokio::test]
    async fn test_recovery_failure_revert_and_terminal_failed() {
        let state = Arc::new(ServerState::new(Some(EngineConfig::default())));
        let agent = [1u8; 32];
        let provider = [2u8; 32];
        let sig = [3u8; 64];

        let mut voucher = VoucherPayload::new(2001, agent, provider, 50_000, 60);
        voucher.signature = sig;
        let guard = state.try_acquire_nonce_sync(agent, 2001).unwrap();
        guard.commit_with_voucher(NoncePhase::IntentSigned(sig), voucher).unwrap();

        let mut swept = state.extract_and_lock_intent_vouchers();
        assert_eq!(swept.len(), 1);

        swept[0].retry_count += 1;
        state.promote_phase_with_voucher_sync(
            swept[0].nonce,
            NoncePhase::IntentSigned(swept[0].signature),
            swept[0].clone(),
        ).unwrap();

        let mut swept_2 = state.extract_and_lock_intent_vouchers();
        assert_eq!(swept_2.len(), 1);
        assert_eq!(swept_2[0].retry_count, 1);

        swept_2[0].retry_count += 1;
        state.promote_phase_with_voucher_sync(
            swept_2[0].nonce,
            NoncePhase::IntentSigned(swept_2[0].signature),
            swept_2[0].clone(),
        ).unwrap();

        let mut swept_3 = state.extract_and_lock_intent_vouchers();
        assert_eq!(swept_3.len(), 1);
        assert_eq!(swept_3[0].retry_count, 2);

        swept_3[0].retry_count += 1;
        state.mark_voucher_failed(swept_3[0].nonce, &swept_3[0].agent).unwrap();

        assert_eq!(
            state.pending_locks.get(&2001).unwrap().state,
            NoncePhase::Failed
        );

        let swept_terminal = state.extract_and_lock_intent_vouchers();
        assert!(swept_terminal.is_empty());
    }

    #[tokio::test]
    async fn test_recovery_success_finalized() {
        let state = Arc::new(ServerState::new(Some(EngineConfig::default())));
        let agent = [1u8; 32];
        let provider = [2u8; 32];
        let sig = [3u8; 64];

        let mut voucher = VoucherPayload::new(3001, agent, provider, 50_000, 60);
        voucher.signature = sig;
        let guard = state.try_acquire_nonce_sync(agent, 3001).unwrap();
        guard.commit_with_voucher(NoncePhase::IntentSigned(sig), voucher).unwrap();

        let swept = state.extract_and_lock_intent_vouchers();
        assert_eq!(swept.len(), 1);

        state.promote_phase_sync(swept[0].nonce, NoncePhase::Finalized).unwrap();

        assert_eq!(
            state.pending_locks.get(&3001).unwrap().state,
            NoncePhase::Finalized
        );

        assert!(state.extract_and_lock_intent_vouchers().is_empty());
    }
}
