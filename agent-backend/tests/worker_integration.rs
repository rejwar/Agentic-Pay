//! Integration test: verifies worker transaction construction, instruction pairing,
//! and Anchor data layout compatibility.

use agent_backend::solana_rpc::AsyncSolanaProvider;
use agent_backend::state::ServerState;
use agent_backend::voucher::{VoucherCryptography, VoucherPayload};
use agent_backend::worker::{
    build_batch_settle_instruction, build_ed25519_instruction, SettlementWorker, WorkerConfig,
    BATCH_SETTLE_VOUCHERS_DISCRIMINATOR,
};
use solana_sdk::{
    message::VersionedMessage,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};
use std::sync::Arc;
use std::time::Duration;

#[tokio::test]
async fn test_worker_transaction_and_discriminator_integration() {
    let agent_keypair = Keypair::new();
    let agent_pubkey = agent_keypair.pubkey().to_bytes();
    let provider_pubkey = [42u8; 32];

    let mut voucher = VoucherPayload::new(5001, agent_pubkey, provider_pubkey, 250_000, 120);
    voucher.sign_voucher(&agent_keypair).expect("Signing voucher failed");

    // 1. Verify canonical message and signature
    let canonical = voucher.canonical_bytes();
    assert_eq!(canonical.len(), 105);

    // 2. Verify Ed25519 instruction builder
    let ed25519_ix = build_ed25519_instruction(&agent_pubkey, &voucher.signature, &canonical);
    assert_eq!(ed25519_ix.program_id, solana_sdk::ed25519_program::id());
    assert_eq!(ed25519_ix.data[0], 1); // 1 signature
    assert_eq!(&ed25519_ix.data[16..48], &agent_pubkey);
    assert_eq!(&ed25519_ix.data[48..112], &voucher.signature);
    assert_eq!(&ed25519_ix.data[112..217], &canonical);

    // 3. Verify Anchor batch_settle_vouchers instruction builder
    let program_id = Pubkey::from_str_const("Grd1111111111111111111111111111111111111111");
    let (escrow_pda, _bump) = Pubkey::find_program_address(
        &[b"escrow", agent_keypair.pubkey().as_ref()],
        &program_id,
    );
    let payer = agent_keypair.pubkey();
    let settle_ix = build_batch_settle_instruction(
        &program_id,
        &escrow_pda,
        &payer,
        &provider_pubkey,
        &voucher,
        &canonical,
    );

    assert_eq!(settle_ix.program_id, program_id);
    assert_eq!(&settle_ix.data[..8], &BATCH_SETTLE_VOUCHERS_DISCRIMINATOR);
    assert_eq!(settle_ix.accounts.len(), 6);
    assert_eq!(settle_ix.accounts[0].pubkey, escrow_pda);
    let (nonce_receipt_pda, _bump) = Pubkey::find_program_address(
        &[b"nonce", escrow_pda.as_ref(), &voucher.nonce.to_le_bytes()],
        &program_id,
    );
    assert_eq!(settle_ix.accounts[1].pubkey, nonce_receipt_pda);
    assert_eq!(settle_ix.accounts[2].pubkey, Pubkey::new_from_array(provider_pubkey));
    assert_eq!(settle_ix.accounts[3].pubkey, solana_sdk::sysvar::instructions::id());
    assert_eq!(settle_ix.accounts[4].pubkey, payer);
    assert_eq!(settle_ix.accounts[5].pubkey, solana_sdk::system_program::id());

    // 4. Verify SettlementWorker builds valid VersionedTransaction
    let state = Arc::new(ServerState::new(None));
    let rpc = Arc::new(AsyncSolanaProvider::new(
        Arc::new(solana_client::nonblocking::rpc_client::RpcClient::new(
            "http://localhost:8899".to_string(),
        )),
        Duration::from_secs(10),
    ));

    let config = WorkerConfig {
        program_id,
        escrow_owner: agent_keypair.pubkey(),
        fee_payer: Some(agent_keypair.pubkey()),
        ..WorkerConfig::default()
    };

    let worker = SettlementWorker::new(
        state,
        rpc,
        config,
        Arc::new(agent_keypair),
    );

    let batch = vec![voucher];
    let tx = worker.build_batch_transaction(&batch).expect("Failed to build transaction");
    match tx.message {
        VersionedMessage::V0(msg) => {
            assert_eq!(msg.instructions.len(), 2);
        }
        _ => panic!("Expected v0 versioned message"),
    }
    assert_eq!(tx.signatures.len(), 1);
    assert_ne!(tx.signatures[0], solana_sdk::signature::Signature::default());
}
