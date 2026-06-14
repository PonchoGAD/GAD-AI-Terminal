-- Migration 017: coin_launches table (tracks tokens launched via /auto_launch)
CREATE TABLE IF NOT EXISTS coin_launches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mint_address TEXT UNIQUE NOT NULL,
  ticker       TEXT NOT NULL,
  name         TEXT,
  dev_buy_sol  NUMERIC(10,4) DEFAULT 0,
  image_url    TEXT,
  meta_uri     TEXT,
  create_tx    TEXT,
  coin_idea_id UUID REFERENCES coin_ideas(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS coin_launches_created_at_idx ON coin_launches(created_at DESC);
