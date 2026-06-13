-- Migration 012: Futures Trading Module (Drift Protocol on Solana)
-- Mode: paper_trading (default) | live (FUTURES_LIVE_MODE=true)

CREATE TABLE IF NOT EXISTS futures_positions (
  id                  SERIAL PRIMARY KEY,
  trade_id            VARCHAR(64) UNIQUE NOT NULL,
  symbol              VARCHAR(20) NOT NULL DEFAULT 'SOL-PERP',
  side                VARCHAR(4)  NOT NULL CHECK (side IN ('LONG','SHORT')),
  mode                VARCHAR(12) NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper','live')),

  -- Entry
  entry_price         NUMERIC(18,6) NOT NULL,
  size_usdc           NUMERIC(12,4) NOT NULL,
  leverage            SMALLINT     NOT NULL DEFAULT 2,
  notional_usdc       NUMERIC(12,4) NOT NULL,
  opened_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Exit
  exit_price          NUMERIC(18,6),
  closed_at           TIMESTAMPTZ,
  close_reason        VARCHAR(40),  -- TP|SL|TRAIL|MANUAL|DAILY_STOP|FORCED

  -- P&L
  pnl_usdc            NUMERIC(12,4),
  pnl_pct             NUMERIC(8,4),
  fee_usdc            NUMERIC(10,6) DEFAULT 0,

  -- Context
  macro_score         SMALLINT,    -- 0-100 macro health at entry
  signal_score        SMALLINT,    -- 0-100 technical signal strength
  ema21               NUMERIC(12,4),
  ema50               NUMERIC(12,4),
  rsi14               NUMERIC(6,2),
  vol_ratio           NUMERIC(6,2),

  -- Drift on-chain
  drift_order_id      VARCHAR(64),
  drift_tx_sig        VARCHAR(128),

  status              VARCHAR(12) NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','closed','cancelled'))
);

CREATE TABLE IF NOT EXISTS futures_signals (
  id          SERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  symbol      VARCHAR(20) NOT NULL DEFAULT 'SOL-PERP',

  -- Technical
  price       NUMERIC(18,6) NOT NULL,
  ema21       NUMERIC(12,4),
  ema50       NUMERIC(12,4),
  rsi14       NUMERIC(6,2),
  vol_ratio   NUMERIC(6,2),
  signal      VARCHAR(8) CHECK (signal IN ('LONG','SHORT','FLAT')),
  signal_str  SMALLINT,   -- 0-100

  -- Macro
  btc_trend   VARCHAR(8),
  fg_index    SMALLINT,
  macro_ok    BOOLEAN,
  macro_score SMALLINT,

  -- Capital
  suggested_usdc  NUMERIC(10,4),
  suggested_lev   SMALLINT,
  daily_pnl_usdc  NUMERIC(10,4),
  daily_stop_hit  BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS futures_capital (
  id              SERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_usdc      NUMERIC(12,4) NOT NULL,
  available_usdc  NUMERIC(12,4) NOT NULL,
  in_trade_usdc   NUMERIC(12,4) DEFAULT 0,
  daily_pnl_usdc  NUMERIC(12,4) DEFAULT 0,
  total_pnl_usdc  NUMERIC(12,4) DEFAULT 0,
  win_streak      SMALLINT DEFAULT 0,
  loss_streak     SMALLINT DEFAULT 0,
  trades_today    SMALLINT DEFAULT 0,
  daily_stop_hit  BOOLEAN DEFAULT FALSE
);

-- Seed initial capital record
INSERT INTO futures_capital (total_usdc, available_usdc)
VALUES (5.10, 5.10)
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_futures_positions_status ON futures_positions(status);
CREATE INDEX IF NOT EXISTS idx_futures_signals_ts ON futures_signals(ts DESC);
CREATE INDEX IF NOT EXISTS idx_futures_capital_ts ON futures_capital(ts DESC);
