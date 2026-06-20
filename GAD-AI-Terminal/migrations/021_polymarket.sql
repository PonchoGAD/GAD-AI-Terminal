-- Migration 021: Polymarket prediction market trading bot
-- Dry-run mode by default; POLYMARKET_DRY_RUN=false for live trading

-- Cached active markets from Polymarket Gamma API
CREATE TABLE IF NOT EXISTS polymarket_markets (
    market_id       TEXT PRIMARY KEY,          -- conditionId (hex)
    title           TEXT NOT NULL,              -- market question
    category        TEXT DEFAULT 'general',
    volume_usd      NUMERIC(18,2) DEFAULT 0,
    token_id_yes    TEXT NOT NULL,
    token_id_no     TEXT NOT NULL,
    price_yes       NUMERIC(10,4) DEFAULT 0.5,  -- mid price [0.01-0.99]
    price_no        NUMERIC(10,4) DEFAULT 0.5,
    ends_at         TIMESTAMPTZ NOT NULL,
    is_active       BOOLEAN DEFAULT true,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pm_markets_volume ON polymarket_markets(volume_usd DESC);
CREATE INDEX IF NOT EXISTS idx_pm_markets_ends ON polymarket_markets(ends_at);

-- AI-scored news signals matched to markets
CREATE TABLE IF NOT EXISTS polymarket_signals (
    id              SERIAL PRIMARY KEY,
    market_id       TEXT REFERENCES polymarket_markets(market_id),
    outcome         TEXT NOT NULL,              -- 'YES' | 'NO'
    entry_price     NUMERIC(10,4),
    ai_probability  NUMERIC(10,4),             -- Claude's P(YES) estimate
    ev_score        NUMERIC(10,4),             -- expected value
    confidence      TEXT DEFAULT 'MEDIUM',     -- 'HIGH' | 'MEDIUM' | 'LOW'
    reasoning       TEXT,
    news_source     TEXT,
    news_text       TEXT,                      -- theme/keywords from x_trend_signals
    source_signal_id INTEGER,                  -- x_trend_signals.id (prevent duplicate processing)
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pm_signals_created ON polymarket_signals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pm_signals_source ON polymarket_signals(source_signal_id);

-- Positions (both dry-run and live)
CREATE TABLE IF NOT EXISTS polymarket_positions (
    id              SERIAL PRIMARY KEY,
    market_id       TEXT REFERENCES polymarket_markets(market_id),
    signal_id       INTEGER REFERENCES polymarket_signals(id),
    outcome         TEXT NOT NULL,             -- 'YES' | 'NO'
    amount_usdc     NUMERIC(18,6) NOT NULL,   -- USDC invested (virtual in dry-run)
    shares          NUMERIC(18,6) NOT NULL,    -- number of shares bought
    entry_price     NUMERIC(10,4) NOT NULL,   -- price per share at entry
    token_id        TEXT NOT NULL,            -- CLOB token ID for this outcome
    is_dry_run      BOOLEAN DEFAULT true,
    is_active       BOOLEAN DEFAULT true,
    order_id        TEXT,                     -- CLOB order ID (live only)
    -- Exit fields
    close_price     NUMERIC(10,4),
    close_reason    TEXT,                     -- 'TP' | 'TIME_LIMIT' | 'STOP_LOSS' | 'IMPULSE_TP'
    close_order_id  TEXT,
    pnl_usdc        NUMERIC(18,6),
    closed_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pm_positions_active ON polymarket_positions(is_active) WHERE is_active=true;
CREATE INDEX IF NOT EXISTS idx_pm_positions_market ON polymarket_positions(market_id);

-- Daily trading stats
CREATE TABLE IF NOT EXISTS polymarket_stats (
    date            DATE NOT NULL,
    is_dry_run      BOOLEAN NOT NULL DEFAULT true,
    trades          INTEGER DEFAULT 0,
    wins            INTEGER DEFAULT 0,
    usdc_in         NUMERIC(18,6) DEFAULT 0,
    usdc_out        NUMERIC(18,6) DEFAULT 0,
    pnl_usdc        NUMERIC(18,6) DEFAULT 0,
    PRIMARY KEY (date, is_dry_run)
);
