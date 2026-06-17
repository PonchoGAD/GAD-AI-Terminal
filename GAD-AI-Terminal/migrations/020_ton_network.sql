-- TON Network integration: Jetton positions, trade history
-- Migration 020

CREATE TABLE IF NOT EXISTS ton_positions (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  jetton_address    TEXT          NOT NULL,
  pool_address      TEXT,
  symbol            TEXT,
  name              TEXT,

  -- Entry
  wallet            TEXT          NOT NULL,
  amount_ton        NUMERIC(18,8) NOT NULL,
  token_amount      TEXT,                          -- stored as string (uint128 bigint)
  entry_price_ton   NUMERIC(24,12),                -- TON per readable token
  entry_mcap_usd    NUMERIC(18,2),
  dex               TEXT          DEFAULT 'stonfi_v1',
  buy_tx            TEXT,

  -- Analytics at entry
  safe_score        SMALLINT      DEFAULT 50,
  liq_at_entry      NUMERIC(18,2),
  pc1h_at_entry     NUMERIC(8,3),

  -- Exit
  total_sold_ton    NUMERIC(18,8) DEFAULT 0,
  sell_tx           TEXT,
  sell_reason       TEXT,

  -- TP / trail tracking
  tp_index          SMALLINT      DEFAULT 0,
  trail_high        NUMERIC(12,6) DEFAULT 0,

  -- State
  is_active         BOOLEAN       DEFAULT true,

  -- Timing
  bought_at         TIMESTAMPTZ   DEFAULT NOW(),
  sold_at           TIMESTAMPTZ,
  last_activity_at  TIMESTAMPTZ   DEFAULT NOW(),
  created_at        TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ton_positions_active  ON ton_positions (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_ton_positions_jetton  ON ton_positions (jetton_address);
CREATE INDEX IF NOT EXISTS idx_ton_positions_bought  ON ton_positions (bought_at DESC);

-- Jetton cache (TTL-based, refreshed each scan)
CREATE TABLE IF NOT EXISTS ton_tokens (
  jetton_address    TEXT          PRIMARY KEY,
  pool_address      TEXT,
  symbol            TEXT,
  name              TEXT,
  dex               TEXT,
  decimals          SMALLINT      DEFAULT 9,
  liquidity_usd     NUMERIC(18,2),
  volume_1h         NUMERIC(18,2),
  volume_24h        NUMERIC(18,2),
  price_change_1h   NUMERIC(8,3),
  price_change_5m   NUMERIC(8,3),
  price_ton         NUMERIC(24,12),
  mcap_usd          NUMERIC(18,2),
  holders           INT,
  mintable          BOOLEAN       DEFAULT false,
  admin_renounced   BOOLEAN       DEFAULT false,
  safe_score        SMALLINT      DEFAULT 50,
  updated_at        TIMESTAMPTZ   DEFAULT NOW()
);
