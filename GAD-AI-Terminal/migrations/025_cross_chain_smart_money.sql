-- Migration 025: Cross-chain Smart Money
-- Adds chain discriminator, EVM address normalization, per-chain unique constraint

-- 1. Add chain column (default SOLANA for existing rows)
ALTER TABLE smart_money_wallets
  ADD COLUMN IF NOT EXISTS chain VARCHAR(10) NOT NULL DEFAULT 'SOLANA';

-- 2. Normalize existing data: EVM addresses to lowercase
UPDATE smart_money_wallets
SET wallet_address = LOWER(wallet_address)
WHERE chain = 'BASE' OR wallet_address LIKE '0x%';

-- 3. EVM auto-lowercase trigger
CREATE OR REPLACE FUNCTION normalize_sm_wallet_address()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.wallet_address LIKE '0x%' THEN
    NEW.wallet_address := LOWER(NEW.wallet_address);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_normalize_sm_address ON smart_money_wallets;
CREATE TRIGGER trg_normalize_sm_address
  BEFORE INSERT OR UPDATE ON smart_money_wallets
  FOR EACH ROW EXECUTE FUNCTION normalize_sm_wallet_address();

-- 4. Drop old single-column unique constraint (if any)
ALTER TABLE smart_money_wallets
  DROP CONSTRAINT IF EXISTS smart_money_wallets_wallet_address_key;

-- 5. Per-chain unique constraint
ALTER TABLE smart_money_wallets
  ADD CONSTRAINT IF NOT EXISTS unique_wallet_per_chain
  UNIQUE (wallet_address, chain);

-- 6. Index for efficient chain-filtered queries
CREATE INDEX IF NOT EXISTS idx_sm_wallets_chain
  ON smart_money_wallets (chain, tier);

COMMENT ON COLUMN smart_money_wallets.chain IS 'Network: SOLANA | BASE | TON';
