-- Copy-trading: track wallets to follow and their performance

CREATE TABLE IF NOT EXISTS copy_wallets (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  address      TEXT        UNIQUE NOT NULL,
  label        TEXT        NOT NULL,
  enabled      BOOL        NOT NULL DEFAULT true,
  win_rate     FLOAT       NOT NULL DEFAULT 0,
  total_copies INT         NOT NULL DEFAULT 0,
  last_copy_at TIMESTAMPTZ,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_copy_wallets_enabled ON copy_wallets (enabled) WHERE enabled = true;
