-- Telegram users linked to Solana wallets
CREATE TABLE IF NOT EXISTS telegram_users (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  telegram_id    BIGINT NOT NULL UNIQUE,
  username       TEXT,
  wallet_address TEXT,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tu_wallet ON telegram_users (wallet_address);
