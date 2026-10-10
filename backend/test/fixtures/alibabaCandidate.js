"use strict";
// Fixed causal test fixture shared by provider integration and qualification tests.
function feature(current, baseline, extra = {}) {
  return {
    current,
    baseline,
    delta: current - baseline,
    observed_at_utc: "2026-09-28T09:58:00.000Z",
    baseline_observed_at_utc: "2026-09-28T09:48:00.000Z",
    available_to_system_at_utc: "2026-09-28T09:58:01.000Z",
    age_seconds: 120,
    status: "OK",
    ...extra,
  };
}
function snapshot() {
  return {
    schema_version: "ORAYAN_ALIBABA_CANDIDATE_V1",
    candidate_id: "cand-1",
    candidate_episode_id: "ep-1",
    candidate_birth_at_utc: "2026-09-28T10:00:00.000Z",
    engine: "NEW_ORAYAN",
    symbol: "TESTUSDT",
    side: "BUY",
    regime: {
      label: "BULL_RANGE",
      strength: 61,
      status: "OK",
      age_seconds: 60,
      observed_at_utc: "2026-09-28T09:59:00.000Z",
      available_to_system_at_utc: "2026-09-28T09:59:00.000Z",
    },
    regime_transitions: { status: "OK", items: [] },
    planned_trade: {
      entry: 100,
      sl: 98,
      tp: 104,
      rr: 2,
      planned_risk_usdt: 0.25,
      planned_heat_usdt: 1.25,
      stop_distance_pct: 2,
      stop_atr_multiple: 1.1,
      quote_evidence: {
        available: true,
        status: "LOCAL_RECEIPT_ONLY",
        bid: 99.99,
        ask: 100.01,
        mark: 100,
        exchange_timestamp_utc: "2026-09-28T09:59:58.000Z",
        observed_at_utc: "2026-09-28T09:59:58.000Z",
        available_to_system_at_utc: "2026-09-28T09:59:58.000Z",
        age_seconds: 2,
      },
    },
    exposure: {
      open_positions_total: 4,
      same_side_count: 3,
      same_side_regime_count: 2,
      same_side_regime_heat_usdt: 1,
      observed_at_utc: "2026-09-28T09:59:59.000Z",
      age_seconds: 1,
    },
    h1: {
      version: "H1_DIRECTION_REGIME_HEAT_V1",
      state: "RETAIN",
      reason_codes: [],
      abstain_reasons: [],
    },
    h2: {
      version: "H2_BIRTH_TIME_DETERIORATION_V1",
      state: "RETAIN",
      alerts: ["linear_breadth:directional_deterioration"],
      abstain_reasons: [],
      features: {
        btc_return_24h: feature(0.01, 0.011),
        eth_return_24h: feature(0.012, 0.013),
        linear_breadth: feature(12, 14, { sample_size: 120 }),
        btc_funding_rate: feature(0.00005, 0.00004),
        eth_funding_rate: feature(0.00004, 0.00003),
        btc_open_interest: feature(1000, 990),
        eth_open_interest: feature(800, 795),
      },
    },
    market_context: {
      status: "OK",
      current: {
        observed_at_utc: "2026-09-28T09:58:00.000Z",
        available_to_system_at_utc: "2026-09-28T09:58:01.000Z",
      },
    },
    market_intelligence: {
      status: "UNAVAILABLE",
      reason: "NOT_PRESENT_AT_CANDIDATE_BIRTH",
    },
    gemini_briefing: {
      status: "UNAVAILABLE",
      reason: "NOT_PRESENT_AT_CANDIDATE_BIRTH",
    },
    score: { value: 74, rr: 2 },
    reason_flags: ["TEST"],
    risk_flags: [],
    sources: [
      {
        name: "new_orayan_birth",
        status: "OK",
        available_to_system_at_utc: "2026-09-28T10:00:00.000Z",
        age_seconds: 0,
      },
      {
        name: "market_environment_scan",
        status: "OK",
        available_to_system_at_utc: "2026-09-28T09:58:01.000Z",
        age_seconds: 119,
      },
    ],
  };
}

module.exports = snapshot;
