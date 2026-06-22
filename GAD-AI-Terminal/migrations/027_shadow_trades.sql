-- Migration 027: Shadow Mode trades table
-- Records what ALL bots WOULD buy without spending real money.
-- Purpose: validate filter profitability before risking funds.
-- Created: 2026-06-22

CREATE TABLE IF NOT EXISTS shadow_trades (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain            VARCHAR(20) NOT NULL,   -- 'solana' | 'base' | 'bsc' | 'ton' | 'pumpfun'
  strategy         VARCHAR(40) NOT NULL,   -- 'raydium' | 'base-scan' | 'bsc-scan' | 'bonding-smart'
  symbol           VARCHAR(20),
  contract_address VARCHAR(100) NOT NULL,
  entry_price      NUMERIC(30, 18),
  entry_mcap_usd   NUMERIC(20, 2),
  entry_liq_usd    NUMERIC(20, 2),
  entry_pc1h       NUMERIC(10, 2),
  filter_params    JSONB,
  tp1_target       NUMERIC(10, 2),         -- e.g. 30 = +30% TP target
  stop_pct         NUMERIC(10, 2),         -- e.g. 8 = -8% stop-loss
  -- Price checkpoints (% change from entry)
  check_30m_pct    NUMERIC(10, 2),
  check_1h_pct     NUMERIC(10, 2),
  check_4h_pct     NUMERIC(10, 2),
  check_8h_pct     NUMERIC(10, 2),
  -- Outcome
  status           VARCHAR(20) DEFAULT 'open',  -- 'open' | 'tp1_hit' | 'stopped' | 'expired'
  outcome_price    NUMERIC(30, 18),
  outcome_pct      NUMERIC(10, 2),
  outcome_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shadow_trades_status  ON shadow_trades(status);
CREATE INDEX IF NOT EXISTS idx_shadow_trades_chain   ON shadow_trades(chain, strategy);
CREATE INDEX IF NOT EXISTS idx_shadow_trades_created ON shadow_trades(created_at DESC);
