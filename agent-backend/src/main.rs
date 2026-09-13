use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use jsonrpsee::server::ServerBuilder;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

use agent_backend::agent_loop::AgentLoop;
use agent_backend::client::X402Client;
use agent_backend::config::Config;
use agent_backend::decision::{EvaluatorConfig, FixedPointEvaluator};
use agent_backend::rpc::{AgentRpcServer, RpcServer};
use agent_backend::solana_rpc::AsyncSolanaProvider;
use agent_backend::state::{self, ServerState};
use agent_backend::wallet::AgentWallet;
use agent_backend::worker::{SettlementWorker, WorkerConfig};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::init();

    let cfg = Config::from_env()?;
    let solana_client = Arc::new(RpcClient::new(cfg.rpc_url.clone()));
    let rpc_client = Arc::new(AsyncSolanaProvider::new(
        solana_client,
        Duration::from_secs(cfg.nonce_ttl_secs),
    ));

    let engine_config = state::EngineConfig {
        max_in_flight_per_agent: cfg.max_in_flight_per_agent,
        nonce_ttl: Duration::from_secs(cfg.nonce_ttl_secs),
        max_rate_limit_units: cfg.max_rate_limit_units,
        rate_limit_per_sec: cfg.rate_limit_per_sec,
    };
    let state = Arc::new(ServerState::new(Some(engine_config)));
    state.clone().spawn_cleanup_task(Duration::from_secs(10));

    // Load agent keypair (from AGENT_SECRET_KEY env var or generate a dev keypair)
    let agent_keypair = Arc::new(
        std::env::var("AGENT_SECRET_KEY")
            .ok()
            .and_then(|s| Keypair::from_base58_string(&s).into())
            .unwrap_or_else(Keypair::new),
    );

    // Configure and spawn the settlement worker daemon
    let worker_config = WorkerConfig {
        batch_interval: Duration::from_secs(10),
        max_retries: 3,
        retry_backoff_base: Duration::from_secs(2),
        program_id: Pubkey::from_str_const("Grd1111111111111111111111111111111111111111"),
        escrow_owner: agent_keypair.pubkey(),
        fee_payer: Some(agent_keypair.pubkey()),
    };

    let worker = Arc::new(SettlementWorker::new(
        state.clone(),
        rpc_client.clone(),
        worker_config,
        agent_keypair.clone(),
    ));

    tokio::spawn(async move {
        worker.run().await;
    });

    // Configure and spawn the autonomous execution loop
    let agent_wallet = Arc::new(AgentWallet::from_keypair(&agent_keypair));
    let resource_url = std::env::var("RESOURCE_SERVER_URL")
        .unwrap_or_else(|_| "http://localhost:8080".into());
    let x402_client = Arc::new(X402Client::new(resource_url, agent_wallet.clone())?);
    let evaluator = Arc::new(FixedPointEvaluator::new(EvaluatorConfig::default()));
    let trading_symbol = std::env::var("TRADING_PAIR").unwrap_or_else(|_| "SOLUSDT".to_string());

    let mut agent_loop = AgentLoop::new(
        x402_client,
        evaluator,
        state.clone(),
        agent_wallet,
        trading_symbol,
    );

    tokio::spawn(async move {
        if let Err(e) = agent_loop.run().await {
            tracing::error!("Autonomous agent loop stopped: {}", e);
        }
    });

    let rpc_impl = RpcServer::new(state, rpc_client);
    let rpc_service = AgentRpcServer::into_rpc(rpc_impl);

    let addr = SocketAddr::from(([127, 0, 0, 1], 8545));
    let server = ServerBuilder::new().build(addr).await?;
    let handle = server.start(rpc_service);
    println!("JSON-RPC server started at http://{}", addr);
    handle.stopped().await;
    Ok(())
}
