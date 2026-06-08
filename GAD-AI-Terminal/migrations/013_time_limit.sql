-- Migration 013: Time limit for stale positions + sell reason tracking

ALTER TABLE autobuy_jobs
  ADD COLUMN IF NOT EXISTS bought_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_activity_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS time_limit_seconds INT     NOT NULL DEFAULT 3600,
  ADD COLUMN IF NOT EXISTS time_limit_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE autosell_stages
  ADD COLUMN IF NOT EXISTS sell_reason TEXT;

-- Backfill bought_at from last_run_at for already-bought jobs
UPDATE autobuy_jobs
SET    bought_at        = last_run_at,
       last_activity_at = last_run_at
WHERE  entry_price_sol IS NOT NULL
  AND  last_run_at     IS NOT NULL
  AND  bought_at       IS NULL;

CREATE INDEX IF NOT EXISTS idx_autobuy_time_limit
  ON autobuy_jobs (active, time_limit_enabled, last_activity_at)
  WHERE active = true AND time_limit_enabled = true;
