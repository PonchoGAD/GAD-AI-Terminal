-- Migration 016: X (Twitter) trend signals table
-- Tracks detected trends, matched coins, and actions taken

CREATE TABLE IF NOT EXISTS x_trend_signals (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  theme      TEXT NOT NULL,
  keywords   TEXT[] DEFAULT '{}',
  tweet_url  TEXT,
  engagement INT DEFAULT 0,
  coin_mint  TEXT,
  coin_symbol TEXT,
  action     TEXT DEFAULT 'NONE',  -- ALERT_SENT / NO_COIN / TRADED / LAUNCHED
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS x_trend_signals_theme_idx       ON x_trend_signals(theme);
CREATE INDEX IF NOT EXISTS x_trend_signals_created_at_idx  ON x_trend_signals(created_at DESC);
CREATE INDEX IF NOT EXISTS x_trend_signals_coin_mint_idx   ON x_trend_signals(coin_mint) WHERE coin_mint IS NOT NULL;
