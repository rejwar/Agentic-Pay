//! JSON‑RPC server exposing agent payment endpoints.

use crate::error::EngineError;
use crate::solana_rpc::AsyncSolanaProvider;
use crate::state::{NoncePhase, ServerState, SolanaRpcAdapter, TransactionStatus};
use crate::voucher::VoucherCryptography;
use base64::Engine;
use jsonrpsee::{core::RpcResult, proc_macros::rpc};
use solana_sdk::{pubkey::Pubkey, signature::Signature};
use std::str::FromStr;
use std::sync::Arc;

// ---------- RPC Trait ----------
#[rpc(server, namespace = "agent")]
pub trait AgentRpc {
    /// Get the balance of an agent's wallet (in lamports).
    /// `pubkey` – Base58‑encoded Solana public key.
    #[method(name = "getBalance")]
    async fn get_balance(&self, pubkey: String) -> RpcResult<u64>;

    /// Submit a signed transaction (instant settlement path).
    /// `tx_data` – Base64‑encoded transaction bytes (VersionedTransaction).
    /// `agent_pubkey` – Base58‑encoded agent public key.
    /// `nonce` – client-generated unique nonce.
    #[method(name = "submitTransaction")]
    async fn submit_transaction(
        &self,
        tx_data: String,
        agent_pubkey: String,
        nonce: u64,
    ) -> RpcResult<String>; // returns transaction signature (Base58)

    /// Submit a deferred voucher (intent to pay) for batch settlement.
    /// `voucher_data` – serialised voucher (implementation‑specific).
    /// `agent_pubkey` – Base58‑encoded agent public key.
    /// `nonce` – client-generated unique nonce.
    #[method(name = "submitVoucher")]
    async fn submit_voucher(
        &self,
        voucher_data: String,
        agent_pubkey: String,
        nonce: u64,
    ) -> RpcResult<String>; // returns voucher ID

    /// Get the status of a transaction by its signature.
    /// `signature` – Base58‑encoded transaction signature.
    #[method(name = "getTransactionStatus")]
    async fn get_transaction_status(&self, signature: String) -> RpcResult<TransactionStatus>;

    /// Get the current in‑flight count for an agent.
    /// `agent_pubkey` – Base58‑encoded agent public key.
    #[method(name = "getInFlightCount")]
    async fn get_in_flight_count(&self, agent_pubkey: String) -> RpcResult<usize>;

    /// Calculate Value of Information (VOI): whether buying premium oracle data
    /// yields positive expected value given current confidence vs expected confidence.
    #[method(name = "shouldBuyData")]
    async fn should_buy_data(
        &self,
        current_confidence_bps: u64,
        expected_after: u64,
        data_cost_bps: u64,
    ) -> RpcResult<bool>;
}

// ---------- Server Implementation ----------
pub struct RpcServer {
    state: Arc<ServerState>,
    rpc_client: Arc<AsyncSolanaProvider>,
}

impl RpcServer {
    pub fn new(state: Arc<ServerState>, rpc_client: Arc<AsyncSolanaProvider>) -> Self {
        Self { state, rpc_client }
    }

    /// Parse a Base58‑encoded or 64-character hex public key into a byte array.
    fn parse_pubkey(&self, key: &str) -> Result<[u8; 32], EngineError> {
        if key.len() == 64 {
            if let Ok(bytes) = hex::decode(key) {
                if let Ok(arr) = bytes.try_into() {
                    return Ok(arr);
                }
            }
        }
        Pubkey::from_str(key)
            .map(|pk| pk.to_bytes())
            .map_err(|_| EngineError::InvalidPubkey(key.to_string()))
    }

    /// Parse a Base58‑encoded signature into a byte array.
    fn parse_signature(&self, sig: &str) -> Result<[u8; 64], EngineError> {
        Signature::from_str(sig)
            .map(|s| s.into())
            .map_err(|_| EngineError::InvalidSignature(sig.to_string()))
    }
}

#[async_trait::async_trait]
impl AgentRpcServer for RpcServer {
    async fn get_balance(&self, pubkey: String) -> RpcResult<u64> {
        let pk = self
            .parse_pubkey(&pubkey)
            .map_err(|e| jsonrpsee::types::error::ErrorObject::owned(400, e.to_string(), None::<()>))?;

        match self.rpc_client.get_balance(&pk).await {
            Ok(balance) => Ok(balance),
            Err(e) => Err(jsonrpsee::types::error::ErrorObject::owned(
                500,
                format!("RPC error: {}", e),
                None::<()>,
            )),
        }
    }

    async fn submit_transaction(
        &self,
        tx_data: String,
        agent_pubkey: String,
        nonce: u64,
    ) -> RpcResult<String> {
        // 1. Parse agent pubkey (Base58)
        let agent = self
            .parse_pubkey(&agent_pubkey)
            .map_err(|e| jsonrpsee::types::error::ErrorObject::owned(400, e.to_string(), None::<()>))?;

        // 2. Acquire nonce (idempotency, rate limiting, in‑flight caps)
        let guard = self
            .state
            .try_acquire_nonce_sync(agent, nonce)
            .map_err(|e| jsonrpsee::types::error::ErrorObject::owned(409, e.to_string(), None::<()>))?;

        // 3. Decode Base64 transaction bytes.
        let tx_bytes = base64::engine::general_purpose::STANDARD
            .decode(&tx_data)
            .map_err(|e| jsonrpsee::types::error::ErrorObject::owned(400, format!("Invalid Base64: {}", e), None::<()>))?;

        // 4. Send via async RPC client (non‑blocking)
        let sig_bytes = match self.rpc_client.send_transaction(&tx_bytes).await {
            Ok(sig) => sig,
            Err(e) => {
                // Drop guard – marks as Failed and frees budget, leaves nonce in map.
                drop(guard);
                return Err(jsonrpsee::types::error::ErrorObject::owned(
                    500,
                    format!("RPC error: {}", e),
                    None::<()>,
                ));
            }
        };

        // 5. Commit the guard: promote to Broadcasted, free concurrency budget, keep nonce.
        if let Err(e) = guard.commit(NoncePhase::Broadcasted(sig_bytes)) {
            return Err(jsonrpsee::types::error::ErrorObject::owned(
                500,
                format!("State error: {}", e),
                None::<()>,
            ));
        }

        // 6. Return signature as Base58 (Solana default)
        let signature = Signature::from(sig_bytes);
        Ok(signature.to_string())
    }

    async fn submit_voucher(
        &self,
        voucher_data: String,
        agent_pubkey: String,
        nonce: u64,
    ) -> RpcResult<String> {
        let agent = self
            .parse_pubkey(&agent_pubkey)
            .map_err(|e| jsonrpsee::types::error::ErrorObject::owned(400, e.to_string(), None::<()>))?;

        // Decode the Base64 voucher (170-byte wire format).
        let voucher = crate::voucher::decode_voucher_header(&voucher_data)
            .map_err(|e| jsonrpsee::types::error::ErrorObject::owned(
                400, format!("Invalid voucher: {}", e), None::<()>))?;

        // Verify Ed25519 signature — this is the real gate.
        voucher.verify_voucher()
            .map_err(|e| jsonrpsee::types::error::ErrorObject::owned(
                400, format!("Bad signature: {}", e), None::<()>))?;

        // Verify the pubkey matches.
        if voucher.agent != agent {
            return Err(jsonrpsee::types::error::ErrorObject::owned(
                400, "Agent pubkey mismatch", None::<()>));
        }

        // Verify the nonce matches.
        if voucher.nonce != nonce {
            return Err(jsonrpsee::types::error::ErrorObject::owned(
                400, "Nonce mismatch", None::<()>));
        }

        // Acquire nonce in the state engine.
        let guard = self
            .state
            .try_acquire_nonce_sync(agent, nonce)
            .map_err(|e| jsonrpsee::types::error::ErrorObject::owned(409, e.to_string(), None::<()>))?;

        // Commit with the real voucher.
        guard
            .commit_with_voucher(NoncePhase::IntentSigned(voucher.signature), voucher)
            .map_err(|e| jsonrpsee::types::error::ErrorObject::owned(500, e.to_string(), None::<()>))?;

        // Return an identifier for the voucher.
        Ok(format!("voucher-{}", nonce))
    }

    async fn get_transaction_status(&self, signature: String) -> RpcResult<TransactionStatus> {
        let sig = self
            .parse_signature(&signature)
            .map_err(|e| jsonrpsee::types::error::ErrorObject::owned(400, e.to_string(), None::<()>))?;

        match self.rpc_client.get_transaction_status(&sig).await {
            Ok(Some(status)) => Ok(status),
            Ok(None) => Ok(TransactionStatus {
                confirmed: false,
                finalized: false,
                slot: None,
                error: Some("Transaction not found".to_string()),
            }),
            Err(e) => Err(jsonrpsee::types::error::ErrorObject::owned(
                500,
                format!("RPC error: {}", e),
                None::<()>,
            )),
        }
    }

    async fn get_in_flight_count(&self, agent_pubkey: String) -> RpcResult<usize> {
        let agent = self
            .parse_pubkey(&agent_pubkey)
            .map_err(|e| jsonrpsee::types::error::ErrorObject::owned(400, e.to_string(), None::<()>))?;
        Ok(self.state.in_flight_count(&agent))
    }

    async fn should_buy_data(
        &self,
        current_confidence_bps: u64,
        expected_after: u64,
        data_cost_bps: u64,
    ) -> RpcResult<bool> {
        Ok(crate::decision::should_buy_data(
            current_confidence_bps,
            expected_after,
            data_cost_bps,
            10_000,
        ))
    }
}