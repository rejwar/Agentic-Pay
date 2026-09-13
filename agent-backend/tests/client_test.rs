use std::sync::Arc;
use agent_backend::client::{PaymentTerms, X402Client};
use agent_backend::rpc::{AgentRpcServer, RpcServer};
use agent_backend::wallet::AgentWallet;

#[tokio::test]
async fn test_client_voucher_creation_and_signing() {
    let wallet = Arc::new(
        AgentWallet::from_hex_secret(
            "0000000000000000000000000000000000000000000000000000000000000001",
        )
        .unwrap(),
    );

    let client = X402Client::new("http://127.0.0.1:8080", wallet.clone()).unwrap();

    let terms = PaymentTerms {
        price: 1000,
        network: "solana".into(),
        recipient: "11111111111111111111111111111111".into(),
        ttl: 60,
        scheme: "agenticpay_x402v1".into(),
    };

    // Verify signing succeeds and produces valid canonical length and nonces
    let voucher1 = client.sign_voucher_for_terms(&terms).unwrap();
    let voucher2 = client.sign_voucher_for_terms(&terms).unwrap();

    assert_eq!(voucher1.amount_lamports, 1000);
    assert_eq!(voucher1.nonce + 1, voucher2.nonce);
    assert_eq!(voucher1.agent, wallet.pubkey_bytes());
}

#[tokio::test]
async fn test_submit_voucher_validation() {
    use agent_backend::solana_rpc::AsyncSolanaProvider;
    use agent_backend::state::ServerState;
    use agent_backend::voucher::encode_voucher_header;
    use solana_client::nonblocking::rpc_client::RpcClient;
    use std::time::Duration;

    let wallet = Arc::new(
        AgentWallet::from_hex_secret(
            "0000000000000000000000000000000000000000000000000000000000000001",
        )
        .unwrap(),
    );
    let state = Arc::new(ServerState::new(None));
    let rpc_client = Arc::new(AsyncSolanaProvider::new(
        Arc::new(RpcClient::new("http://127.0.0.1:8899".to_string())),
        Duration::from_secs(5),
    ));
    let server = RpcServer::new(state, rpc_client);

    let terms = PaymentTerms {
        price: 5000,
        network: "solana".into(),
        recipient: "11111111111111111111111111111111".into(),
        ttl: 60,
        scheme: "agenticpay_x402v1".into(),
    };

    let client = X402Client::new("http://127.0.0.1:8080", wallet.clone()).unwrap();
    let voucher = client.sign_voucher_for_terms(&terms).unwrap();
    let encoded = encode_voucher_header(&voucher);
    let agent_pubkey = wallet.pubkey().to_string();

    // 1. Valid submission succeeds
    let res = server
        .submit_voucher(encoded.clone(), agent_pubkey.clone(), voucher.nonce)
        .await;
    assert!(res.is_ok());
    assert_eq!(res.unwrap(), format!("voucher-{}", voucher.nonce));

    // 2. Duplicate submission with same nonce fails (already acquired)
    let dup_res = server
        .submit_voucher(encoded.clone(), agent_pubkey.clone(), voucher.nonce)
        .await;
    assert!(dup_res.is_err());

    // 3. Mismatched nonce fails
    let nonce_mismatch = server
        .submit_voucher(encoded.clone(), agent_pubkey.clone(), voucher.nonce + 100)
        .await;
    assert!(nonce_mismatch.is_err());

    // 4. Mismatched agent pubkey fails
    let other_wallet = AgentWallet::from_hex_secret(
        "0000000000000000000000000000000000000000000000000000000000000002",
    )
    .unwrap();
    let wrong_agent = server
        .submit_voucher(encoded.clone(), other_wallet.pubkey().to_string(), voucher.nonce + 1)
        .await;
    assert!(wrong_agent.is_err());

    // 5. Tampered signature fails
    let mut tampered = voucher.clone();
    tampered.nonce = 99999;
    let tampered_encoded = encode_voucher_header(&tampered);
    let bad_sig = server
        .submit_voucher(tampered_encoded, agent_pubkey, 99999)
        .await;
    assert!(bad_sig.is_err());
}

#[tokio::test]
#[ignore] // Requires the resource server running on localhost:8080
async fn test_fetch_price_with_x402() {
    let secret = std::env::var("AGENT_SECRET_KEY")
        .unwrap_or_else(|_| "0000000000000000000000000000000000000000000000000000000000000001".into());
    let wallet = Arc::new(AgentWallet::from_hex_secret(&secret).unwrap());
    let client = X402Client::new("http://127.0.0.1:8080", wallet).unwrap();
    let feed = client.fetch_price("BTC").await.unwrap();
    assert!(feed.price > 0);
}
