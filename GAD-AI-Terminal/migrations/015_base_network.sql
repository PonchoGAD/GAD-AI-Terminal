-- Base Network integration: positions, trades, token cache
-- Migration 015

CREATE TABLE IF NOT EXISTS base_positions (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_address  TEXT          NOT NULL,
  symbol            TEXT,
  name              TEXT,

  -- Entry
  wallet            TEXT          NOT NULL,
  amount_eth        NUMERIC(18,8) NOT NULL,
  token_amount      TEXT,                          -- stored as string (bigint)
  entry_price_eth   NUMERIC(24,12),
  entry_mcap_usd    NUMERIC(18,2),
  dex               TEXT          DEFAULT 'uniswap_v3',
  fee_tier          INT           DEFAULT 3000,
  buy_tx            TEXT,

  -- Exit
  total_sold_eth    NUMERIC(18,8) DEFAULT 0,
  sell_tx           TEXT,
  sell_reason       TEXT,

  -- TP / trail tracking
  tp_index          SMALLINT      DEFAULT 0,
  trail_high        NUMERIC(24,12) DEFAULT 0,

  -- State
  is_active         BOOLEAN       DEFAULT true,

  -- Timing
  bought_at         TIMESTAMPTZ   DEFAULT NOW(),
  sold_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ   DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS base_tokens (
  contract_address  TEXT          PRIMARY KEY,
  symbol            TEXT,
  name              TEXT,
  decimals          SMALLINT      DEFAULT 18,
  liquidity_usd     NUMERIC(18,2),
  volume_1h         NUMERIC(18,2),
  volume_24h        NUMERIC(18,2),
  price_change_1h   NUMERIC(8,3),
  price_change_5m   NUMERIC(8,3),
  holders           INT,
  is_verified       BOOLEAN       DEFAULT false,
  lp_locked         BOOLEAN       DEFAULT false,
  safe_score        NUMERIC(5,2),
  dex_id            TEXT,
  pair_address      TEXT,
  last_seen         TIMESTAMPTZ   DEFAULT NOW(),
  created_at        TIMESTAMPTZ   DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS base_stats (
  id       SERIAL      PRIMARY KEY,
  wallet   TEXT        NOT NULL,
  date     DATE        NOT NULL DEFAULT CURRENT_DATE,
  trades   INT         DEFAULT 0,
  wins     INT         DEFAULT 0,
  eth_in   NUMERIC(18,8) DEFAULT 0,
  eth_out  NUMERIC(18,8) DEFAULT 0,
  pnl_eth  NUMERIC(18,8) DEFAULT 0,
  UNIQUE (wallet, date)
);

CREATE INDEX IF NOT EXISTS idx_base_positions_wallet  ON base_positions(wallet);
CREATE INDEX IF NOT EXISTS idx_base_positions_bought  ON base_positions(bought_at DESC);
CREATE INDEX IF NOT EXISTS idx_base_positions_open    ON base_positions(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_base_tokens_liq        ON base_tokens(liquidity_usd DESC);
CREATE INDEX IF NOT EXISTS idx_base_tokens_seen       ON base_tokens(last_seen DESC);
