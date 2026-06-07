-- Migration 012: add auto_trade_processed flag to alerts
-- Used by auto-signal processor to avoid reprocessing the same signal
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS auto_trade_processed BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_alerts_unprocessed
  ON alerts (type, score, created_at)
  WHERE auto_trade_processed = false;
