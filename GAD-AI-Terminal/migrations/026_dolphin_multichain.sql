-- migrations/026_dolphin_multichain.sql
-- Smart Money wallet registry — cross-chain sniper tracking
-- Populated automatically by scripts/sm-discovery.ts (Dolphin engine)

CREATE TABLE IF NOT EXISTS smart_money_wallets (
    id                SERIAL PRIMARY KEY,
    chain             VARCHAR(10)  NOT NULL,              -- 'SOLANA', 'BASE', 'BSC', 'TON'
    wallet_address    TEXT         NOT NULL,              -- Base58 (Solana), 0x hex (EVM), Raw addr (TON)
    wallet_rank       VARCHAR(15)  DEFAULT 'STANDARD',   -- 'ELITE', 'PROVEN', 'STANDARD'
    reliability_weight NUMERIC     DEFAULT 1.0,           -- Signal weight multiplier (1.0-3.0)
    win_rate          NUMERIC      DEFAULT 0.0,           -- Historical WR (0.0-1.0)
    net_profit_usd    NUMERIC      DEFAULT 0.0,           -- Lifetime net profit in USD
    last_active_at    TIMESTAMPTZ  DEFAULT NOW(),         -- Last on-chain tx timestamp
    active            BOOLEAN      DEFAULT true,          -- false = dormant >5 days
    created_at        TIMESTAMPTZ  DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  DEFAULT NOW()
);

-- One wallet per chain — prevents duplicate tracking
CREATE UNIQUE INDEX IF NOT EXISTS idx_smw_chain_address
    ON smart_money_wallets(chain, LOWER(wallet_address));

-- Fast lookup for active wallets by chain (used by copy-trader)
CREATE INDEX IF NOT EXISTS idx_smw_active_lookup
    ON smart_money_wallets(chain, active)
    WHERE active = true;

-- Dolphin discovery run log — tracks when each chain was last scanned
CREATE TABLE IF NOT EXISTS dolphin_discovery_runs (
    id           SERIAL PRIMARY KEY,
    chain        VARCHAR(10) NOT NULL,
    wallets_found   INTEGER DEFAULT 0,
    wallets_added   INTEGER DEFAULT 0,
    wallets_purged  INTEGER DEFAULT 0,
    ran_at       TIMESTAMPTZ DEFAULT NOW()
);
