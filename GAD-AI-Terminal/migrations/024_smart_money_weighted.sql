-- Migration 024: Smart Money Wallets — multi-network + reliability weights
-- Extends existing table to support Solana, Base, TON networks
-- and weighted signal detection (БЛОК 2.2 from bonding-smart v2 design)

ALTER TABLE smart_money_wallets
  ADD COLUMN IF NOT EXISTS network           TEXT    NOT NULL DEFAULT 'solana',
  ADD COLUMN IF NOT EXISTS associated_token  TEXT,
  ADD COLUMN IF NOT EXISTS buy_timestamp     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sol_profit        NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reliability_weight NUMERIC DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS early_rank        INT     DEFAULT 99,
  ADD COLUMN IF NOT EXISTS total_signals     INT     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_signal_at    TIMESTAMPTZ;

-- Fast lookup during WebSocket stream (key hot path)
CREATE INDEX IF NOT EXISTS idx_sm_wallet_address   ON smart_money_wallets(wallet_address);
CREATE INDEX IF NOT EXISTS idx_sm_network_active   ON smart_money_wallets(network, active);
CREATE INDEX IF NOT EXISTS idx_sm_weight_desc      ON smart_money_wallets(network, reliability_weight DESC)
  WHERE active = true;

-- Update existing Solana wallets to weight 1.0 (baseline)
UPDATE smart_money_wallets SET reliability_weight = 1.0 WHERE reliability_weight IS NULL;

COMMENT ON COLUMN smart_money_wallets.reliability_weight IS
  'Signal weight: 1.0 standard, 2.0 proven sniper (top-10 early), 3.0 elite (top-3 entry + multiple tokens)';
COMMENT ON COLUMN smart_money_wallets.network IS
  'Chain: solana | base | ton';
COMMENT ON COLUMN smart_money_wallets.early_rank IS
  'Position in first-buyers list (1 = very first buyer) — lower = higher weight';
