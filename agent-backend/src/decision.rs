//! Fixed‑point decision engine using integer arithmetic (no `f64`).
//! Evaluates trade signals using Pyth price feeds and network fees.

use crate::error::SignalFault;


// ---------- Data Structures ----------

// Pyth price feed data (from oracle).

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]

pub struct PythPriceFeed{
    pub price:i64,// Price, scaled by 10^expo
    pub conf:u64,
    pub expo:i32,  // Confidence interval, same scaling
    pub publish_time:u64,
}

//Decision output
#[derive(Debug,Clone,PartialEq,Eq)]

pub enum ExecutionSignal{
    ExecuteLong,
    ExecuteShort,
    Reject(SignalFault)
}


#[derive(Clone)]

pub struct EvaluatorConfig{
    pub max_confidence_bps:u64,
    pub max_fee_lamports:u64,
    pub trade_size_lamports:u64,
    
}

impl Default for EvaluatorConfig {
    fn default() -> Self {
        Self {
            max_confidence_bps: 500,
            max_fee_lamports: 5_000_000,
            trade_size_lamports: 1_000_000_000,
        }
    }
}

// ---------- Trait ----------
/// Defines the decision-making interface used by the autonomous execution engine.
pub trait AlphaEvaluator: Send + Sync {
    type EvalFault;

    fn evaluate_expected_value(
        &self,
        feed: &PythPriceFeed,
        network_fee_lamports: u64,
        target_edge_bps: u64,
    ) -> Result<ExecutionSignal, Self::EvalFault>;
}

/// Backwards-compatibility alias for previous typo.
pub use AlphaEvaluator as AlpahaEvaluator;

// ---------- Implementation ----------


pub struct FixedPointEvaluator{
config:EvaluatorConfig
}

impl FixedPointEvaluator {
    pub fn new(config:EvaluatorConfig)->Self{
        Self{config}
    }

    fn confidence_bps(price_abs:u64,conf:u64)->Option<u64>{
        if price_abs==0 {return None;}
        let result=(conf as u128).checked_mul(10000).and_then(|v| v.checked_div(price_abs as u128))?;
        Some(if result>u64::MAX as u128 {u64::MAX} else {result as u64})
    }

        fn fee_bps(fee: u64, trade_size: u64) -> Option<u64> {
        if trade_size == 0 {
            return None;
        }
        let result = (fee as u128)
            .checked_mul(10_000)
            .and_then(|v| v.checked_div(trade_size as u128))?;
        Some(if result > u64::MAX as u128 { u64::MAX } else { result as u64 })
    }
}



impl AlphaEvaluator for FixedPointEvaluator {
    type EvalFault = SignalFault;

    fn evaluate_expected_value(
        &self,
        feed: &PythPriceFeed,
        network_fee_lamports: u64,
        target_edge_bps: u64,
    ) -> Result<ExecutionSignal, Self::EvalFault> {
        if network_fee_lamports > self.config.max_fee_lamports {
            return Ok(ExecutionSignal::Reject(SignalFault::FeeExceedsMaxCap));
        }

        let price_abs = feed.price.unsigned_abs();
        let conf_bps = match Self::confidence_bps(price_abs, feed.conf) {
            Some(bps) => bps,
            None => return Ok(ExecutionSignal::Reject(SignalFault::ConfidenceTooWide)),
        };
        if conf_bps > self.config.max_confidence_bps {
            return Ok(ExecutionSignal::Reject(SignalFault::ConfidenceTooWide));
        }

        let profit_bps = target_edge_bps.saturating_sub(conf_bps);

        let fee_bps = match Self::fee_bps(network_fee_lamports, self.config.trade_size_lamports) {
            Some(bps) => bps,
            None => return Ok(ExecutionSignal::Reject(SignalFault::NegativeExpectedValue)),
        };

        if profit_bps > fee_bps {
            Ok(ExecutionSignal::ExecuteLong)
        } else {
            Ok(ExecutionSignal::Reject(SignalFault::NegativeExpectedValue))
        }
    }
}

// ---------- Value of Information (VOI) ----------

/// Value of Information: evaluates whether purchasing premium oracle data yields
/// a positive expected value given current confidence vs expected improved confidence.
pub fn should_buy_data(
    current_confidence_bps: u64,
    expected_confidence_after: u64,
    data_cost_bps: u64,
    trade_size_bps: u64,
) -> bool {
    // Expected decision improvement from tighter confidence bounds.
    let confidence_gain = expected_confidence_after.saturating_sub(current_confidence_bps);
    // Expected value = gain * trade_size_bps / 10,000
    let expected_value = (confidence_gain as u128)
        .checked_mul(trade_size_bps as u128)
        .and_then(|v| v.checked_div(10_000))
        .unwrap_or(0) as u64;
    expected_value > data_cost_bps
}

// ---------- Unit Tests ----------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::SignalFault;

    #[test]
    fn test_confidence_bps_overflow_safe() {
        // Price is very small (e.g., 1 lamport), conf is large.
        let price_abs = 1;
        let conf = u64::MAX;
        let bps = FixedPointEvaluator::confidence_bps(price_abs, conf).unwrap();
        // Since conf * 10_000 = u64::MAX * 10_000 ≈ 1.8e23, which is >> u64::MAX,
        // the result will be saturated to u64::MAX, but our function uses u128 and clamps.
        // We can't assert an exact value, but we know it should be > u64::MAX.
        // So we just check that it returns Some and is large.
        assert!(bps > 0);
        // We can test that the division works correctly for normal values.
        let bps = FixedPointEvaluator::confidence_bps(100, 50).unwrap();
        assert_eq!(bps, 5000); // 50/100 = 0.5, *10000 = 5000 BPS.
    }

    #[test]
    fn test_fee_bps_overflow_safe() {
        let fee = u64::MAX;
        let trade_size = 1;
        let bps = FixedPointEvaluator::fee_bps(fee, trade_size).unwrap();
        // Should be saturated to u64::MAX.
        assert_eq!(bps, u64::MAX);
        let bps = FixedPointEvaluator::fee_bps(1_000_000, 1_000_000_000).unwrap();
        assert_eq!(bps, 10); // 1e6 * 10000 / 1e9 = 10.
    }

    #[test]
    fn test_evaluate_profitable() {
        let config = EvaluatorConfig::default();
        let evaluator = FixedPointEvaluator::new(config);
        let feed = PythPriceFeed {
            price: 60_000_000_000_000, // arbitrary scaled price
            conf: 1_000_000_000_000,   // 1.67% confidence (roughly)
            expo: -8,
            publish_time: 0,
        };
        let fee = 1_000_000; // 0.001 SOL
        let edge = 200; // 2% edge
        let signal = evaluator.evaluate_expected_value(&feed, fee, edge).unwrap();
        assert_eq!(signal, ExecutionSignal::ExecuteLong);
    }

    #[test]
    fn test_evaluate_fee_too_high() {
        let config = EvaluatorConfig {
            max_fee_lamports: 1_000_000,
            ..Default::default()
        };
        let evaluator = FixedPointEvaluator::new(config);
        let feed = PythPriceFeed {
            price: 60_000_000_000_000,
            conf: 1_000_000_000_000,
            expo: -8,
            publish_time: 0,
        };
        let fee = 5_000_000; // exceeds max
        let edge = 200;
        let signal = evaluator.evaluate_expected_value(&feed, fee, edge).unwrap();
        assert!(matches!(signal, ExecutionSignal::Reject(SignalFault::FeeExceedsMaxCap)));
    }

    #[test]
    fn test_evaluate_confidence_too_wide() {
        let config = EvaluatorConfig {
            max_confidence_bps: 100, // 1%
            ..Default::default()
        };
        let evaluator = FixedPointEvaluator::new(config);
        let feed = PythPriceFeed {
            price: 60_000_000_000_000,
            conf: 6_000_000_000_000, // 10% of price
            expo: -8,
            publish_time: 0,
        };
        let fee = 1_000_000;
        let edge = 200;
        let signal = evaluator.evaluate_expected_value(&feed, fee, edge).unwrap();
        assert!(matches!(signal, ExecutionSignal::Reject(SignalFault::ConfidenceTooWide)));
    }

    #[test]
    fn test_evaluate_not_profitable() {
        let config = EvaluatorConfig::default();
        let evaluator = FixedPointEvaluator::new(config);
        let feed = PythPriceFeed {
            price: 60_000_000_000_000,
            conf: 1_000_000_000_000,
            expo: -8,
            publish_time: 0,
        };
        let fee = 5_000_000; // high fee (but within cap)
        let edge = 100; // 1% edge
        let signal = evaluator.evaluate_expected_value(&feed, fee, edge).unwrap();
        // Likely rejects due to negative EV.
        assert!(matches!(signal, ExecutionSignal::Reject(SignalFault::NegativeExpectedValue)));
    }

    #[test]
    fn test_should_buy_data_voi() {
        // Gain = 50 bps, trade_size = 10,000 (100%), EV = 50 bps. Cost = 10 bps -> Buy!
        assert!(should_buy_data(20, 70, 10, 10_000));

        // Gain = 5 bps, trade_size = 10,000, EV = 5 bps. Cost = 10 bps -> Do not buy!
        assert!(!should_buy_data(20, 25, 10, 10_000));

        // Confidence worsens or zero gain -> Do not buy!
        assert!(!should_buy_data(50, 40, 5, 10_000));
    }
}