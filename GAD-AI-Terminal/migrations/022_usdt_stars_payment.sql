-- Migration 022: USDT (EVM/BSC) + Telegram Stars payment methods
-- New pricing: $5/24h | $10/3d | $100/30d
-- BSC USDT treasury: process.env.BSC_WALLET_PUBLIC_KEY
-- Stars rate: $2.29 per 100 stars → $5=219 | $10=437 | $100=4367

ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price_usd     NUMERIC(10,2) DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price_stars   INTEGER       DEFAULT 0;

UPDATE subscription_plans SET price_usd = 5.00,   price_stars = 219  WHERE slug = 'trial_1d';
UPDATE subscription_plans SET price_usd = 10.00,  price_stars = 437  WHERE slug = 'trial_3d';
UPDATE subscription_plans SET price_usd = 100.00, price_stars = 4367 WHERE slug = 'monthly';

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS payment_type TEXT DEFAULT 'sol';

CREATE INDEX IF NOT EXISTS idx_subscriptions_tg_wallet ON subscriptions(wallet_address)
  WHERE wallet_address LIKE 'tg_%';
