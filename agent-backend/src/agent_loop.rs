//! The autonomous loop: observe market → detect signal → buy data → decide → settle.

use crate::client::X402Client;
use crate::decision::{AlphaEvaluator, ExecutionSignal, FixedPointEvaluator};
use crate::error::EngineError;
use crate::state::ServerState;
use crate::wallet::AgentWallet;

use futures_util::StreamExt;
use std::sync::Arc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};

pub struct AgentLoop {
    pub client: Arc<X402Client>,
    pub evaluator: Arc<FixedPointEvaluator>,
    pub state: Arc<ServerState>,
    pub wallet: Arc<AgentWallet>,
    pub symbol: String,
    /// Rolling window of recent prices (for volatility detection).
    window: Vec<f64>,
    window_size: usize,
    /// Volatility threshold in basis points.
    vol_threshold_bps: u64,
    /// Minimum seconds between paid data fetches.
    cooldown_secs: u64,
    last_fetch: Option<std::time::Instant>,
}

impl AgentLoop {
    pub fn new(
        client: Arc<X402Client>,
        evaluator: Arc<FixedPointEvaluator>,
        state: Arc<ServerState>,
        wallet: Arc<AgentWallet>,
        symbol: String,
    ) -> Self {
        Self {
            client,
            evaluator,
            state,
            wallet,
            symbol,
            window: Vec::with_capacity(60),
            window_size: 60,
            vol_threshold_bps: 50, // 0.5% move triggers
            cooldown_secs: 30,
            last_fetch: None,
        }
    }

    pub async fn run(&mut self) -> Result<(), EngineError> {
        let stream_symbol = self.symbol.to_lowercase().replace('/', "");
        let url = format!(
            "wss://stream.binance.com:9443/ws/{}@trade",
            stream_symbol
        );
        info!("Connecting to market stream: {}", url);

        loop {
            match connect_async(&url).await {
                Ok((ws, _)) => {
                    info!("Connected to live market WebSocket for {}", self.symbol);
                    let (_write, mut read) = ws.split();

                    while let Some(msg) = read.next().await {
                        match msg {
                            Ok(Message::Text(text)) => {
                                if let Some(price) = parse_trade_price(&text) {
                                    if let Err(e) = self.tick(price).await {
                                        warn!("Error during price tick processing: {}", e);
                                    }
                                }
                            }
                            Ok(Message::Ping(_)) => {}
                            Ok(Message::Close(_)) => {
                                warn!("WebSocket connection closed by remote peer. Reconnecting...");
                                break;
                            }
                            Err(e) => {
                                warn!("WebSocket read error: {}. Reconnecting...", e);
                                break;
                            }
                            _ => {}
                        }
                    }
                }
                Err(e) => {
                    warn!("WebSocket connection to {} failed: {}. Retrying in 5s...", url, e);
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    }

    pub async fn tick(&mut self, price: f64) -> Result<(), EngineError> {
        self.window.push(price);
        if self.window.len() > self.window_size {
            self.window.remove(0);
        }
        if self.window.len() < self.window_size {
            return Ok(());
        }

        // Compute rolling volatility (standard deviation / mean in bps).
        let vol_bps = compute_volatility_bps(&self.window);
        if vol_bps < self.vol_threshold_bps {
            return Ok(());
        }

        // Cooldown to avoid hammering the resource server.
        if let Some(last) = self.last_fetch {
            if last.elapsed().as_secs() < self.cooldown_secs {
                return Ok(());
            }
        }

        info!(
            "🔔 Trigger: volatility {} bps exceeds threshold ({} bps)",
            vol_bps, self.vol_threshold_bps
        );

        // ─── Buy premium data ────────────────────────────────────────────
        let feed = self.client.fetch_price(&self.symbol).await?;
        self.last_fetch = Some(std::time::Instant::now());

        info!(
            "📊 Premium data purchased via x402: price={} conf={} expo={}",
            feed.price, feed.conf, feed.expo
        );

        // ─── Decide ──────────────────────────────────────────────────────
        let network_fee = 5_000u64; // lamports
        let target_edge_bps = 100; // 1% target
        match self.evaluator.evaluate_expected_value(&feed, network_fee, target_edge_bps) {
            Ok(ExecutionSignal::ExecuteLong) => {
                info!("✅ Decision: EXECUTE LONG on {}", self.symbol);
            }
            Ok(ExecutionSignal::ExecuteShort) => {
                info!("✅ Decision: EXECUTE SHORT on {}", self.symbol);
            }
            Ok(ExecutionSignal::Reject(fault)) => {
                info!("❌ Decision: REJECT ({})", fault);
            }
            Err(e) => warn!("Evaluator error: {}", e),
        }
        Ok(())
    }
}

pub fn parse_trade_price(json: &str) -> Option<f64> {
    // {"e":"trade","p":"145.23", ...}
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    v.get("p")?.as_str()?.parse().ok()
}

pub fn compute_volatility_bps(window: &[f64]) -> u64 {
    if window.is_empty() {
        return 0;
    }
    let mean: f64 = window.iter().sum::<f64>() / window.len() as f64;
    if mean <= 0.0 {
        return 0;
    }
    let variance: f64 =
        window.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / window.len() as f64;
    let stddev = variance.sqrt();
    ((stddev / mean) * 10_000.0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_trade_price() {
        let json =
            r#"{"e":"trade","E":1672531199999,"s":"SOLUSDT","t":12345,"p":"145.23","q":"10"}"#;
        assert_eq!(parse_trade_price(json), Some(145.23));

        let invalid = r#"{"e":"trade"}"#;
        assert_eq!(parse_trade_price(invalid), None);
    }

    #[test]
    fn test_compute_volatility_bps() {
        // Uniform prices -> 0 volatility
        let flat = vec![100.0; 10];
        assert_eq!(compute_volatility_bps(&flat), 0);

        // Volatile prices -> positive bps
        let volatile = vec![100.0, 105.0, 95.0, 100.0, 110.0, 90.0];
        let vol = compute_volatility_bps(&volatile);
        assert!(vol > 0);
    }
}
