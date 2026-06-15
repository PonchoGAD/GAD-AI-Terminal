-- BSC (Binance Smart Chain) integration: Four.meme scanner + PancakeSwap trading
-- Migration 018

CREATE TABLE IF NOT EXISTS bsc_positions (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_address  TEXT          NOT NULL,
  symbol            TEXT,
  name              TEXT,

  -- Entry
  wallet            TEXT          NOT NULL,
  amount_bnb        NUMERIC(18,8) NOT NULL,
  token_amount      TEXT,                        -- stored as string (uint256 bigint)
  entry_price_bnb   NUMERIC(24,12),
  entry_mcap_usd    NUMERIC(18,2),
  dex               TEXT          DEFAULT 'pancakeswap_v2',
  buy_tax           NUMERIC(5,2)  DEFAULT 0,
  sell_tax          NUMERIC(5,2)  DEFAULT 0,
  buy_tx            TEXT,

  -- Exit
  total_sold_bnb    NUMERIC(18,8) DEFAULT 0,
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
  last_activity_at  TIMESTAMPTZ   DEFAULT NOW(),
  created_at        TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bsc_positions_active   ON bsc_positions (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_bsc_positions_contract ON bsc_positions (contract_address);
CREATE INDEX IF NOT EXISTS idx_bsc_positions_bought   ON bsc_positions (bought_at DESC);

CREATE TABLE IF NOT EXISTS bsc_tokens (
  contract_address  TEXT          PRIMARY KEY,
  symbol            TEXT,
  name              TEXT,
  decimals          SMALLINT      DEFAULT 18,
  liquidity_usd     NUMERIC(18,2),
  volume_1h         NUMERIC(18,2),
  volume_24h        NUMERIC(18,2),
  price_change_1h   NUMERIC(8,3),
  price_change_5m   NUMERIC(8,3),
  holders           INT           DEFAULT 0,
  is_verified       BOOLEAN       DEFAULT false,
  is_honeypot       BOOLEAN       DEFAULT false,
  buy_tax           NUMERIC(5,2)  DEFAULT 0,
  sell_tax          NUMERIC(5,2)  DEFAULT 0,
  safe_score        NUMERIC(5,1)  DEFAULT 50,
  top_holder_pct    NUMERIC(5,2)  DEFAULT 0,
  dex_id            TEXT,
  pair_address      TEXT,
  source            TEXT          DEFAULT 'dexscreener', -- 'four_meme' | 'dexscreener' | 'gecko'
  last_seen         TIMESTAMPTZ   DEFAULT NOW(),
  created_at        TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bsc_tokens_last_seen ON bsc_tokens (last_seen DESC);

CREATE TABLE IF NOT EXISTS bsc_stats (
  date        DATE          NOT NULL,
  wallet      TEXT          NOT NULL,
  trades      INT           DEFAULT 0,
  wins        INT           DEFAULT 0,
  bnb_in      NUMERIC(18,8) DEFAULT 0,
  bnb_out     NUMERIC(18,8) DEFAULT 0,
  pnl_bnb     NUMERIC(18,8) GENERATED ALWAYS AS (bnb_out - bnb_in) STORED,
  PRIMARY KEY (date, wallet)
);
