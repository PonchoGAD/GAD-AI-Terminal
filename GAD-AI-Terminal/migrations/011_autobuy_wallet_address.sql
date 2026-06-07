-- Migration 011: add wallet_address to autobuy_jobs for subscription audit trail
ALTER TABLE autobuy_jobs ADD COLUMN IF NOT EXISTS wallet_address TEXT;
